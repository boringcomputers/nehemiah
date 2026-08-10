import { TemplateInfrastructureUnavailable, TemplateIntegrityError, validateScopedObjectGrant, validTemplateChecksum } from '../domain/templates.js';
export class PostgresTemplateReplicaRepository {
    database;
    constructor(database) {
        this.database = database;
    }
    async enqueueMissing() {
        const result = await this.database.query(`INSERT INTO template_replicas (template_id, host_id, state, progress)
			 SELECT t.id, h.id, 'requested', 0
			 FROM templates t JOIN hosts h
			   ON h.architecture = t.manifest->>'architecture'
			  AND h.state IN ('ready', 'draining')
			 WHERE t.deleted_at IS NULL
			 ON CONFLICT (template_id, host_id) DO NOTHING`);
        return result.rowCount ?? 0;
    }
    async claim() {
        const result = await this.database.query(`WITH candidate AS MATERIALIZED (
			 SELECT tr.template_id, t.organization_id, t.project_id, t.name, t.version,
			        tr.host_id, host(h.address) AS host_address,
			        t.host_template_name, t.object_key, t.checksum, t.size_bytes, t.manifest
			 FROM template_replicas tr
			 JOIN templates t ON t.id = tr.template_id
			 JOIN hosts h ON h.id = tr.host_id
			 WHERE t.deleted_at IS NULL AND h.state IN ('ready', 'draining')
			   AND (
			     tr.state = 'requested'
			     OR (tr.state = 'failed' AND tr.updated_at < now() - interval '1 minute')
			     OR (tr.state = 'pulling' AND tr.updated_at < now() - interval '15 minutes')
			   )
			 ORDER BY CASE tr.state WHEN 'requested' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
			          tr.updated_at, tr.template_id, tr.host_id
			 FOR UPDATE OF tr SKIP LOCKED LIMIT 1
			), claimed AS (
			 UPDATE template_replicas tr SET state = 'pulling', progress = 1,
			        verified_checksum = NULL, error = NULL, updated_at = now()
			 FROM candidate c
			 WHERE tr.template_id = c.template_id AND tr.host_id = c.host_id
			 RETURNING tr.template_id, tr.host_id
			)
			SELECT c.* FROM candidate c JOIN claimed USING (template_id, host_id)`, []);
        const row = result.rows[0];
        return row
            ? {
                templateId: row.template_id,
                organizationId: row.organization_id,
                projectId: row.project_id,
                name: row.name,
                version: row.version,
                hostId: row.host_id,
                hostAddress: row.host_address,
                hostTemplateName: row.host_template_name,
                objectKey: row.object_key,
                checksum: row.checksum,
                sizeBytes: Number(row.size_bytes),
                manifest: row.manifest
            }
            : undefined;
    }
    async markReady(templateId, hostId, verifiedChecksum) {
        const result = await this.database.query(`UPDATE template_replicas tr SET state = 'ready', progress = 100,
			        verified_checksum = $3, error = NULL, updated_at = now()
			 FROM templates t
			 WHERE tr.template_id = $1 AND tr.host_id = $2 AND tr.state = 'pulling'
			   AND t.id = tr.template_id AND t.deleted_at IS NULL
			   AND t.checksum = $3`, [templateId, hostId, verifiedChecksum]);
        return Boolean(result.rowCount);
    }
    async markFailed(templateId, hostId, reason) {
        await this.database.query(`UPDATE template_replicas SET state = 'failed', progress = 0,
			        verified_checksum = NULL, error = $3, updated_at = now()
			 WHERE template_id = $1 AND host_id = $2 AND state = 'pulling'`, [templateId, hostId, reason.slice(0, 256)]);
    }
}
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const validWork = (work) => {
    const expectedObjectKey = `organizations/${work.organizationId}/projects/${work.projectId}/templates/${work.name}/${work.version}/${work.templateId}/snapshot.tar.zst`;
    return ([work.templateId, work.organizationId, work.projectId, work.name, work.version].every((value) => safeSegment.test(value)) &&
        /^t-[a-f0-9]{29}$/.test(work.hostTemplateName) &&
        work.hostAddress.length > 0 &&
        work.objectKey === expectedObjectKey &&
        validTemplateChecksum(work.checksum) &&
        Number.isSafeInteger(work.sizeBytes) &&
        work.sizeBytes > 0 &&
        work.manifest.schema_version === 1 &&
        work.manifest.format === 'firecracker-snapshot-v1' &&
        ['x86_64', 'aarch64'].includes(work.manifest.architecture) &&
        /^m_[A-Za-z0-9_-]{1,126}$/.test(work.manifest.source.machine_id) &&
        work.manifest.artifact.object_key === work.objectKey &&
        work.manifest.artifact.checksum === work.checksum &&
        work.manifest.artifact.size_bytes === work.sizeBytes);
};
export class TemplateReplicationJob {
    repository;
    storage;
    activator;
    now;
    constructor(repository, storage, activator, now = () => new Date()) {
        this.repository = repository;
        this.storage = storage;
        this.activator = activator;
        this.now = now;
    }
    async runOnce() {
        if (!this.storage || !this.activator) {
            throw new TemplateInfrastructureUnavailable('Durable template replication is not configured on this control plane.');
        }
        const enqueued = await this.repository.enqueueMissing();
        const work = await this.repository.claim();
        if (!work)
            return { state: 'idle', enqueued };
        try {
            if (!validWork(work)) {
                throw new TemplateIntegrityError('The persisted template manifest is inconsistent.');
            }
            const stored = await this.storage.stat(work.objectKey);
            if (stored.checksum !== work.checksum || stored.sizeBytes !== work.sizeBytes) {
                throw new TemplateIntegrityError('The durable template artifact failed verification.');
            }
            const now = this.now();
            const download = await this.storage.createDownloadGrant(work.objectKey, new Date(now.getTime() + 10 * 60 * 1_000));
            validateScopedObjectGrant(download, 'GET', now);
            const activated = await this.activator.activate({
                address: work.hostAddress,
                hostTemplateName: work.hostTemplateName,
                architecture: work.manifest.architecture,
                checksum: work.checksum,
                sizeBytes: work.sizeBytes,
                download
            });
            if (activated.checksum !== work.checksum || activated.sizeBytes !== work.sizeBytes) {
                throw new TemplateIntegrityError('The host activation checksum or size did not match the immutable manifest.');
            }
            if (!(await this.repository.markReady(work.templateId, work.hostId, work.checksum))) {
                throw new TemplateIntegrityError('The replica was no longer eligible for activation.');
            }
            return { state: 'ready', enqueued, templateId: work.templateId, hostId: work.hostId };
        }
        catch (error) {
            const reason = error instanceof TemplateIntegrityError ? error.code : 'template_activation_failed';
            await this.repository.markFailed(work.templateId, work.hostId, reason);
            return { state: 'failed', enqueued, templateId: work.templateId, hostId: work.hostId };
        }
    }
}
//# sourceMappingURL=replicate-template.js.map