type SchemaType = string | ReadonlyArray<string>;

interface WireSchema {
	readonly $ref?: string;
	readonly type?: SchemaType;
	readonly const?: unknown;
	readonly enum?: ReadonlyArray<unknown>;
	readonly oneOf?: ReadonlyArray<WireSchema>;
	readonly properties?: Readonly<Record<string, WireSchema>>;
	readonly required?: ReadonlyArray<string>;
	readonly items?: WireSchema;
	readonly additionalProperties?: boolean | WireSchema;
}

interface OpenApiModelsSource {
	readonly info?: { readonly version?: string };
	readonly components?: {
		readonly schemas?: Readonly<Record<string, WireSchema>>;
	};
}

export interface GeneratedModelFile {
	readonly path: string;
	readonly contents: string;
}

const generatedNotice = (comment: string, version: string): string =>
	`${comment} Code generated from Nehemiah OpenAPI ${version} by scripts/openapi-models.mjs. DO NOT EDIT.\n`;

const referencedName = (reference: string): string => {
	const prefix = '#/components/schemas/';
	if (!reference.startsWith(prefix) || reference.length === prefix.length) {
		throw new Error(`unsupported OpenAPI reference: ${reference}`);
	}
	return reference.slice(prefix.length);
};

const literal = (value: unknown, language: 'typescript' | 'python'): string => {
	if (value === null) return language === 'python' ? 'None' : 'null';
	if (typeof value === 'boolean')
		return language === 'python' ? (value ? 'True' : 'False') : String(value);
	if (typeof value === 'number') return String(value);
	if (typeof value === 'string') return JSON.stringify(value);
	throw new Error('OpenAPI model literal is not scalar');
};

const types = (schema: WireSchema): ReadonlyArray<string> =>
	typeof schema.type === 'string' ? [schema.type] : (schema.type ?? []);

const typescriptType = (schema: WireSchema): string => {
	if (schema.$ref) return referencedName(schema.$ref);
	if (schema.const !== undefined) return literal(schema.const, 'typescript');
	if (schema.enum) return schema.enum.map((value) => literal(value, 'typescript')).join(' | ');
	const schemaTypes = types(schema);
	if (schemaTypes.length > 1) {
		return schemaTypes
			.map((type) => typescriptType({ ...schema, type, enum: undefined, const: undefined }))
			.join(' | ');
	}
	if (schemaTypes[0] === 'array') {
		return `ReadonlyArray<${typescriptType(schema.items ?? {})}>`;
	}
	if (schemaTypes[0] === 'object' || schema.properties || schema.additionalProperties) {
		if (!schema.properties) {
			const value =
				typeof schema.additionalProperties === 'object'
					? typescriptType(schema.additionalProperties)
					: 'unknown';
			return `Readonly<Record<string, ${value}>>`;
		}
		const required = new Set(schema.required ?? []);
		const fields = Object.entries(schema.properties).map(
			([name, property]) =>
				`readonly ${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${typescriptType(property)}`
		);
		if (schema.additionalProperties === true) fields.push('readonly [key: string]: unknown');
		return `{ ${fields.join('; ')} }`;
	}
	if (schema.oneOf) return schema.oneOf.map(typescriptType).join(' | ');
	switch (schemaTypes[0]) {
		case 'string':
			return 'string';
		case 'integer':
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'null':
			return 'null';
		default:
			return 'unknown';
	}
};

const renderTypescript = (
	schemas: Readonly<Record<string, WireSchema>>,
	version: string
): string => {
	const blocks = Object.entries(schemas).map(([name, schema]) => {
		if (types(schema)[0] !== 'object' || !schema.properties) {
			return `export type ${name} = ${typescriptType(schema)};`;
		}
		const required = new Set(schema.required ?? []);
		const fields = Object.entries(schema.properties).map(
			([propertyName, property]) =>
				`\treadonly ${JSON.stringify(propertyName)}${required.has(propertyName) ? '' : '?'}: ${typescriptType(property)};`
		);
		if (schema.additionalProperties === true) fields.push('\treadonly [key: string]: unknown;');
		return `export interface ${name} {\n${fields.join('\n')}\n}`;
	});
	return `${generatedNotice('//', version)}\n${blocks.join('\n\n')}\n`;
};

const pythonType = (schema: WireSchema): string => {
	if (schema.$ref) return referencedName(schema.$ref);
	if (schema.const !== undefined) return `Literal[${literal(schema.const, 'python')}]`;
	if (schema.enum) {
		return `Literal[${schema.enum.map((value) => literal(value, 'python')).join(', ')}]`;
	}
	const schemaTypes = types(schema);
	if (schemaTypes.length > 1) {
		return schemaTypes
			.map((type) => pythonType({ ...schema, type, enum: undefined, const: undefined }))
			.join(' | ');
	}
	if (schemaTypes[0] === 'array') return `list[${pythonType(schema.items ?? {})}]`;
	if (schemaTypes[0] === 'object' || schema.properties || schema.additionalProperties) {
		if (schema.properties) return 'dict[str, object]';
		const value =
			typeof schema.additionalProperties === 'object'
				? pythonType(schema.additionalProperties)
				: 'object';
		return `dict[str, ${value}]`;
	}
	if (schema.oneOf) return schema.oneOf.map(pythonType).join(' | ');
	switch (schemaTypes[0]) {
		case 'string':
			return 'str';
		case 'integer':
			return 'int';
		case 'number':
			return 'float';
		case 'boolean':
			return 'bool';
		case 'null':
			return 'None';
		default:
			return 'object';
	}
};

const renderPython = (schemas: Readonly<Record<string, WireSchema>>, version: string): string => {
	const blocks = Object.entries(schemas).map(([name, schema]) => {
		if (types(schema)[0] !== 'object' || !schema.properties) {
			return `${name}: TypeAlias = ${pythonType(schema)}`;
		}
		const required = new Set(schema.required ?? []);
		const fields = Object.entries(schema.properties).map(([propertyName, property]) => {
			const value = pythonType(property);
			return `    ${propertyName}: ${required.has(propertyName) ? value : `NotRequired[${value}]`}`;
		});
		return `class ${name}(TypedDict):\n${fields.length ? fields.join('\n') : '    pass'}`;
	});
	return `${generatedNotice('#', version)}from __future__ import annotations\n\nfrom typing import Literal, NotRequired, TypeAlias, TypedDict\n\n\n${blocks.join('\n\n\n')}\n`;
};

const goIdentifier = (value: string): string => {
	const parts = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
	const result = parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join('');
	return result || 'Value';
};

const goType = (schema: WireSchema): string => {
	if (schema.$ref) return referencedName(schema.$ref);
	const schemaTypes = types(schema);
	if (schemaTypes.includes('null')) {
		const nonNull = schemaTypes.filter((value) => value !== 'null');
		return `*${goType({ ...schema, type: nonNull.length === 1 ? nonNull[0] : nonNull })}`;
	}
	if (schemaTypes[0] === 'array') return `[]${goType(schema.items ?? {})}`;
	if (schemaTypes[0] === 'object' || schema.properties || schema.additionalProperties) {
		if (schema.properties) return 'map[string]any';
		const value =
			typeof schema.additionalProperties === 'object' ? goType(schema.additionalProperties) : 'any';
		return `map[string]${value}`;
	}
	switch (schemaTypes[0]) {
		case 'string':
			return 'string';
		case 'integer':
			return 'int64';
		case 'number':
			return 'float64';
		case 'boolean':
			return 'bool';
		default:
			return 'any';
	}
};

const optionalGoType = (schema: WireSchema): string => {
	const value = goType(schema);
	if (
		value.startsWith('*') ||
		value.startsWith('[]') ||
		value.startsWith('map[') ||
		value === 'any'
	) {
		return value;
	}
	return `*${value}`;
};

const renderGo = (schemas: Readonly<Record<string, WireSchema>>, version: string): string => {
	const blocks = Object.entries(schemas).map(([name, schema]) => {
		if (types(schema)[0] !== 'object' || !schema.properties) {
			const base = goType(schema);
			if (!schema.enum) return `type ${name} ${base}`;
			const constants = schema.enum.map(
				(value) => `\t${name}${goIdentifier(String(value))}\t${name}\t=\t${JSON.stringify(value)}`
			);
			return `type ${name} ${base}\n\nconst (\n${constants.join('\n')}\n)`;
		}
		const required = new Set(schema.required ?? []);
		const fields = Object.entries(schema.properties).map(([propertyName, property]) => {
			const optional = !required.has(propertyName);
			return `\t${goIdentifier(propertyName)}\t${optional ? optionalGoType(property) : goType(property)}\t\`json:"${propertyName}${optional ? ',omitempty' : ''}"\``;
		});
		return `type ${name} struct {\n${fields.join('\n')}\n}`;
	});
	return `${generatedNotice('//', version)}package openapimodels\n\n${blocks.join('\n\n')}\n`;
};

export function generateOpenApiModels(document: unknown): ReadonlyArray<GeneratedModelFile> {
	const source = document as OpenApiModelsSource;
	const schemas = source.components?.schemas;
	if (!schemas || Object.keys(schemas).length === 0) {
		throw new Error('OpenAPI document does not export component schemas');
	}
	const version = source.info?.version ?? 'unknown';
	return [
		{
			path: 'generated/openapi/typescript/models.ts',
			contents: renderTypescript(schemas, version)
		},
		{
			path: 'generated/openapi/python/models.py',
			contents: renderPython(schemas, version)
		},
		{ path: 'generated/openapi/go/models.go', contents: renderGo(schemas, version) }
	];
}
