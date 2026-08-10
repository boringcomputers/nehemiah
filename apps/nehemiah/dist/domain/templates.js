import { randomBytes, randomUUID } from 'node:crypto';
const fromRow = (row) => ({
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    name: row.name,
    version: row.version,
    hostTemplateName: row.host_template_name,
    sourceMachineId: row.source_machine_id,
    manifest: row.manifest,
    objectKey: row.object_key,
    checksum: row.checksum,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? undefined
});
export class PostgresTemplateRepository {
    database;
    constructor(database) {
        this.database = database;
    }
    async list(organizationId, projectId, includeDeleted = false) {
        const result = await this.database.query(`SELECT id, organization_id, project_id, name, version, host_template_name,
			        source_machine_id, manifest, object_key, checksum, size_bytes,
			        created_at, deleted_at
			 FROM templates WHERE organization_id = $1
			   AND ($2::uuid IS NULL OR project_id = $2)
			   AND ($3 OR deleted_at IS NULL)
			 ORDER BY created_at DESC, id`, [organizationId, projectId ?? null, includeDeleted]);
        return result.rows.map(fromRow);
    }
    async insert(template) {
        await this.database.query(`WITH inserted AS (
			 INSERT INTO templates
			  (id, organization_id, project_id, name, version, host_template_name,
			   source_machine_id, manifest, object_key, checksum, size_bytes)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			 RETURNING id
			), queued AS (
			 INSERT INTO template_replicas (template_id, host_id, state, progress)
			 SELECT inserted.id, h.id, 'requested', 0 FROM inserted
			 JOIN hosts h ON h.architecture = $12 AND h.state IN ('ready', 'draining')
			 ON CONFLICT (template_id, host_id) DO NOTHING
			)
			SELECT id FROM inserted`, [
            template.id,
            template.organizationId,
            template.projectId,
            template.name,
            template.version,
            template.hostTemplateName,
            template.sourceMachineId,
            template.manifest,
            template.objectKey,
            template.checksum,
            template.sizeBytes,
            template.manifest.architecture
        ]);
    }
    async findVersion(organizationId, projectId, name, version) {
        const result = await this.database.query(`SELECT id, organization_id, project_id, name, version, host_template_name,
			        source_machine_id, manifest, object_key, checksum, size_bytes,
			        created_at, deleted_at
			 FROM templates WHERE organization_id = $1 AND project_id = $2
			   AND name = $3 AND version = $4`, [organizationId, projectId, name, version]);
        return result.rows[0] ? fromRow(result.rows[0]) : undefined;
    }
    async remove(idOrVersion, organizationId, projectId) {
        return this.database.transaction(async (client) => {
            // Lock first, then check machines in a separate READ COMMITTED statement.
            // If a create held FOR SHARE, waiting here gives this check a fresh snapshot
            // that includes its committed machine row. If delete wins, create waits and
            // rechecks deleted_at after this transaction commits.
            const candidate = await client.query(`SELECT t.id FROM templates t
				 WHERE t.organization_id = $2 AND t.deleted_at IS NULL
				   AND (t.id::text = $1 OR
				        ($3::uuid IS NOT NULL AND t.name || '@' || t.version = $1))
				   AND ($3::uuid IS NULL OR t.project_id = $3)
				 FOR UPDATE OF t`, [idOrVersion, organizationId, projectId ?? null]);
            const templateId = candidate.rows[0]?.id;
            if (!templateId)
                return 'not_found';
            const active = await client.query(`SELECT 1 FROM machines
				 WHERE template_id = $1 AND state NOT IN ('stopped', 'failed', 'lost')
				 LIMIT 1`, [templateId]);
            if (active.rowCount)
                return 'in_use';
            const updated = await client.query(`UPDATE templates SET deleted_at = now()
				 WHERE id = $1 AND deleted_at IS NULL`, [templateId]);
            if (!updated.rowCount)
                return 'not_found';
            // A soft-deleted template must immediately lose every cached/ready route.
            // Keeping this in the same transaction prevents a scheduler from observing
            // deleted_at while a ready replica remains eligible.
            await client.query('DELETE FROM template_replicas WHERE template_id = $1', [templateId]);
            return 'deleted';
        });
    }
}
export class InvalidTemplateRequest extends Error {
    code = 'invalid_template_request';
}
export class TemplateSourceNotFound extends Error {
    code = 'template_source_not_found';
}
export class TemplateSourceNotReady extends Error {
    code = 'template_source_not_ready';
}
export class TemplateVersionConflict extends Error {
    code = 'template_version_conflict';
}
export class TemplateInfrastructureUnavailable extends Error {
    code = 'template_infrastructure_unavailable';
}
export class TemplateIntegrityError extends Error {
    code = 'template_integrity_failed';
}
const templateNamePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const templateVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const tenantSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const checksumPattern = /^sha256:[0-9a-f]{64}$/;
// Durable publication currently uses one immutable, checksum-bound S3 PUT.
// Multipart support needs a separately signed part/commit protocol, so reject
// anything that cannot be bound into the one-request capability.
const maximumArtifactBytes = 5 * 1_024 * 1_024 * 1_024;
export const validTemplateChecksum = (value) => checksumPattern.test(value);
const validArtifact = (value) => validTemplateChecksum(value.checksum) &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes > 0 &&
    value.sizeBytes <= maximumArtifactBytes;
export const validateScopedObjectGrant = (grant, method, now) => {
    let parsed;
    try {
        parsed = new URL(grant.url);
    }
    catch {
        throw new TemplateInfrastructureUnavailable('Object storage returned an invalid scoped grant.');
    }
    if (grant.method !== method ||
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        grant.expiresAt <= now ||
        grant.expiresAt.getTime() - now.getTime() > 15 * 60 * 1_000) {
        throw new TemplateInfrastructureUnavailable('Object storage returned an invalid scoped grant.');
    }
};
const isUniqueViolation = (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
const safeObjectKey = (input) => {
    if (!tenantSegmentPattern.test(input.organizationId) ||
        !tenantSegmentPattern.test(input.projectId)) {
        throw new InvalidTemplateRequest('organization and project identifiers are invalid');
    }
    return `organizations/${input.organizationId}/projects/${input.projectId}/templates/${input.name}/${input.version}/${input.id}/snapshot.tar.zst`;
};
export class TemplateService {
    machines;
    storage;
    publisher;
    now;
    #repository;
    constructor(repository, machines, storage, publisher, now = () => new Date()) {
        this.machines = machines;
        this.storage = storage;
        this.publisher = publisher;
        this.now = now;
        this.#repository =
            'query' in repository ? new PostgresTemplateRepository(repository) : repository;
    }
    list(organizationId, projectId, includeDeleted = false) {
        return this.#repository.list(organizationId, projectId, includeDeleted);
    }
    async publish(input) {
        const name = input.name.trim();
        const version = input.version.trim();
        if (!templateNamePattern.test(name)) {
            throw new InvalidTemplateRequest('name must be 1-63 lowercase letters, numbers, dots, underscores, or dashes');
        }
        if (!templateVersionPattern.test(version)) {
            throw new InvalidTemplateRequest('version must be an immutable 1-64 character identifier');
        }
        if (!/^m_[A-Za-z0-9_-]{1,126}$/.test(input.machineId)) {
            throw new InvalidTemplateRequest('machineId is invalid');
        }
        if (!this.machines || !this.storage || !this.publisher) {
            throw new TemplateInfrastructureUnavailable('Durable template publication is not configured on this control plane.');
        }
        if (await this.#repository.findVersion(input.organizationId, input.projectId, name, version)) {
            throw new TemplateVersionConflict('This template name and version already exist.');
        }
        const machine = await this.machines.get(input.machineId, input.organizationId, input.projectId);
        if (!machine ||
            machine.organizationId !== input.organizationId ||
            machine.projectId !== input.projectId) {
            throw new TemplateSourceNotFound('The source machine was not found.');
        }
        if (machine.state !== 'running' ||
            !machine.ready ||
            machine.expiresAt <= this.now() ||
            !machine.hostId ||
            !machine.hostAddress ||
            !machine.hostMachineId) {
            throw new TemplateSourceNotReady('The source machine must be ready and running.');
        }
        const id = randomUUID();
        const exportId = `te_${id.replaceAll('-', '')}`;
        const hostTemplateName = `t-${randomBytes(15).toString('hex').slice(0, 29)}`;
        const objectKey = safeObjectKey({
            organizationId: input.organizationId,
            projectId: input.projectId,
            name,
            version,
            id
        });
        const now = this.now();
        let exported = false;
        try {
            let hostExport;
            try {
                hostExport = await this.publisher.export({
                    address: machine.hostAddress,
                    hostMachineId: machine.hostMachineId,
                    leaseId: machine.leaseId,
                    exportId
                });
            }
            catch {
                throw new TemplateInfrastructureUnavailable('The source host could not export a durable template.');
            }
            exported = true;
            if (hostExport.exportId !== exportId || !validArtifact(hostExport)) {
                throw new TemplateIntegrityError('The host returned invalid template artifact metadata.');
            }
            const artifact = {
                checksum: hostExport.checksum,
                sizeBytes: hostExport.sizeBytes
            };
            let upload;
            try {
                upload = await this.storage.createUploadGrant(objectKey, artifact, new Date(now.getTime() + 10 * 60 * 1_000));
            }
            catch {
                throw new TemplateInfrastructureUnavailable('Durable object storage could not issue an upload capability.');
            }
            validateScopedObjectGrant(upload, 'PUT', now);
            let hostArtifact;
            try {
                hostArtifact = await this.publisher.upload({
                    address: machine.hostAddress,
                    hostMachineId: machine.hostMachineId,
                    leaseId: machine.leaseId,
                    exportId,
                    artifact,
                    upload
                });
            }
            catch {
                throw new TemplateInfrastructureUnavailable('The source host could not upload its immutable template export.');
            }
            if (!validArtifact(hostArtifact) ||
                hostArtifact.checksum !== artifact.checksum ||
                hostArtifact.sizeBytes !== artifact.sizeBytes) {
                throw new TemplateIntegrityError('The host upload did not match its immutable export.');
            }
            let storedArtifact;
            try {
                storedArtifact = await this.storage.stat(objectKey);
            }
            catch {
                throw new TemplateInfrastructureUnavailable('Durable object storage could not verify the uploaded template.');
            }
            if (!validArtifact(storedArtifact) ||
                storedArtifact.checksum !== hostArtifact.checksum ||
                storedArtifact.sizeBytes !== hostArtifact.sizeBytes) {
                throw new TemplateIntegrityError('The durable artifact does not match the host checksum and size.');
            }
            const manifest = {
                schema_version: 1,
                format: 'firecracker-snapshot-v1',
                architecture: machine.architecture,
                source: { machine_id: machine.id },
                artifact: {
                    object_key: objectKey,
                    checksum: storedArtifact.checksum,
                    size_bytes: storedArtifact.sizeBytes
                }
            };
            const template = {
                id,
                organizationId: input.organizationId,
                projectId: input.projectId,
                name,
                version,
                hostTemplateName,
                sourceMachineId: machine.id,
                manifest,
                objectKey,
                checksum: storedArtifact.checksum,
                sizeBytes: storedArtifact.sizeBytes,
                createdAt: now
            };
            try {
                await this.#repository.insert(template);
            }
            catch (error) {
                if (isUniqueViolation(error)) {
                    throw new TemplateVersionConflict('This template name and version already exist.');
                }
                throw error;
            }
            return template;
        }
        catch (error) {
            // Delete is required to be idempotent so a partial/failed upload is
            // cleaned up as well as a fully uploaded artifact.
            await this.storage.delete(objectKey).catch(() => undefined);
            throw error;
        }
        finally {
            if (exported) {
                await this.publisher
                    .discard({
                    address: machine.hostAddress,
                    hostMachineId: machine.hostMachineId,
                    leaseId: machine.leaseId,
                    exportId
                })
                    .catch(() => undefined);
            }
        }
    }
    remove(idOrVersion, organizationId, projectId) {
        return this.#repository.remove(idOrVersion, organizationId, projectId);
    }
}
export const templateJson = (template) => ({
    id: template.id,
    project_id: template.projectId,
    name: template.name,
    version: template.version,
    manifest: template.manifest,
    checksum: template.checksum,
    size_bytes: template.sizeBytes,
    source_machine_id: template.sourceMachineId,
    created_at: template.createdAt.toISOString()
});
//# sourceMappingURL=templates.js.map