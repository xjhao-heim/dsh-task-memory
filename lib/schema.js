/**
 * Self-contained tool-definition helper.
 *
 * Why this exists instead of importing `defineTool` from `@deepseek-ai/dsh-tools`:
 *
 * A plugin installed with `link:` (or loaded through a junction) is resolved from its real path
 * on disk, so Node's module walk never reaches the profile's `node_modules` and every bare
 * `@deepseek-ai/*` specifier fails. Depending only on the documented registration contract keeps
 * this plugin loadable from any directory and testable with plain `node --test`.
 *
 * The registry contract this reproduces:
 *   - `register()` requires `output.render` to be a function, and the output schema must stay
 *     inside the enforced JSON Schema subset.
 *   - Output values are validated by the registry against `output.schema`.
 *   - Arguments are NOT validated by the registry for a plain definition object, so this module
 *     validates them before the body runs.
 *
 * @module dsh-task-memory/schema
 */

/** Keywords the enforced JSON Schema subset accepts on a node. */
const ALLOWED_NODE_KEYS = new Set([
  "type",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "examples",
]);

/** Scalar JSON types the subset understands. */
const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);

/**
 * Raise a violation with a path-qualified message.
 * @param violations - collector array.
 * @param path - JSON path of the offending value.
 * @param message - what is wrong.
 */
function violate(violations, path, message) {
  violations.push(`${path === "" ? "value" : path}: ${message}`);
}

/**
 * Copy the annotation-only keywords onto a compiled node.
 * @param target - compiled JSON Schema node.
 * @param source - author-facing node.
 * @returns the same compiled node.
 */
function annotate(target, source) {
  for (const key of ["description", "title"]) {
    if (typeof source[key] === "string") target[key] = source[key];
  }
  for (const key of ["default", "examples"]) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  return target;
}

/**
 * Convert an author-facing value schema into the enforced JSON Schema subset.
 *
 * Handles both authoring conventions: a property carrying `required: true` inline (which becomes an
 * entry in the parent's `required` array), and an object node carrying a `required: string[]` array.
 *
 * @param node - author-facing schema node.
 * @param violations - collector for authoring errors.
 * @param path - path used in error messages.
 * @returns a JSON Schema node in the enforced subset.
 */
export function compileValueSchema(node, violations = [], path = "schema") {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    violate(violations, path, "must be a schema object");
    return {};
  }

  if (Array.isArray(node.oneOf)) {
    if (node.oneOf.length < 2) violate(violations, `${path}.oneOf`, "needs at least two branches");
    const compiled = {
      oneOf: node.oneOf.map((branch, index) =>
        compileValueSchema(branch, violations, `${path}.oneOf[${index}]`)),
    };
    return annotate(compiled, node);
  }

  if (node.type === "json") {
    // Annotation-only node: accepts any lossless JSON value.
    return annotate({}, node);
  }

  if (node.type === "object") {
    const properties = {};
    const required = [];
    const declared = node.properties !== undefined && node.properties !== null
      && typeof node.properties === "object"
      ? node.properties
      : {};

    for (const [key, child] of Object.entries(declared)) {
      properties[key] = compileValueSchema(child, violations, `${path}.properties.${key}`);
      if (child !== null && typeof child === "object" && child.required === true) required.push(key);
    }

    const requiredNames = Array.isArray(node.required) ? node.required : required;
    for (const name of requiredNames) {
      if (!Object.prototype.hasOwnProperty.call(properties, name)) {
        violate(violations, `${path}.required`, `names "${name}", which is not declared in properties`);
      }
    }

    const compiled = { type: "object", properties };
    if (requiredNames.length > 0) compiled.required = [...requiredNames];
    // Object openness must be explicit so no accidental JSON Schema default creeps in.
    compiled.additionalProperties = node.additionalProperties === true;
    return annotate(compiled, node);
  }

  if (node.type === "array") {
    const compiled = { type: "array" };
    if (node.items !== undefined) {
      compiled.items = compileValueSchema(node.items, violations, `${path}.items`);
    }
    return annotate(compiled, node);
  }

  if (typeof node.type === "string" && SCALAR_TYPES.has(node.type)) {
    const compiled = { type: node.type };
    if (Array.isArray(node.enum)) compiled.enum = [...node.enum];
    if (node.const !== undefined) compiled.const = node.const;
    return annotate(compiled, node);
  }

  violate(violations, path, "needs a supported type, oneOf, or type 'json'");
  return {};
}

/**
 * Compile a parameter map into the implicit open object root the model sees.
 * @param spec - per-property parameter definitions.
 * @param violations - collector for authoring errors.
 * @returns a JSON Schema object with `properties` and, when needed, `required`.
 */
export function compileParameters(spec, violations = []) {
  return compileValueSchema(
    { type: "object", properties: spec ?? {}, additionalProperties: true },
    violations,
    "parameters",
  );
}

/**
 * Validate a value against a compiled JSON Schema node from the enforced subset.
 * @param schema - compiled JSON Schema node.
 * @param value - candidate value.
 * @param path - path used in violation messages.
 * @param violations - collector.
 */
export function validateValue(schema, value, path, violations) {
  if (schema === null || typeof schema !== "object") return;

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.some((branch) => {
      const branchViolations = [];
      validateValue(branch, value, path, branchViolations);
      return branchViolations.length === 0;
    });
    if (!matched) violate(violations, path, "does not match any allowed variant");
    return;
  }

  if (schema.const !== undefined && value !== schema.const) {
    violate(violations, path, `must equal ${JSON.stringify(schema.const)}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => candidate === value)) {
    violate(violations, path, `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
    return;
  }

  const type = schema.type;
  if (type === undefined) return; // Annotation-only node accepts anything.

  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      violate(violations, path, "must be an object");
      return;
    }
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === undefined) {
        violate(violations, path, `is missing required property "${name}"`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateValue(properties[key], child, path === "" ? key : `${path}.${key}`, violations);
      } else if (schema.additionalProperties === false) {
        violate(violations, path, `has unexpected property "${key}"`);
      }
    }
    return;
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      violate(violations, path, "must be an array");
      return;
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) =>
        validateValue(schema.items, item, `${path}[${index}]`, violations));
    }
    return;
  }

  if (type === "string") {
    if (typeof value !== "string") violate(violations, path, "must be a string");
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") violate(violations, path, "must be a boolean");
    return;
  }
  if (type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) violate(violations, path, "must be an integer");
    return;
  }
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) violate(violations, path, "must be a finite number");
    return;
  }
  if (type === "null" && value !== null) {
    violate(violations, path, "must be null");
  }
}

/**
 * Validate arguments against a compiled parameter schema.
 * @param parameters - compiled parameter schema.
 * @param args - candidate arguments.
 * @returns path-qualified violations; empty means valid.
 */
export function validateArgs(parameters, args) {
  const violations = [];
  validateValue(parameters, args ?? {}, "", violations);
  return violations;
}

/**
 * Define a registry-ready tool.
 *
 * @param options - name, description, parameters, output contract, and body.
 * @returns a ToolDefinition accepted by `ctx.tools.register`.
 * @throws {Error} when the definition is malformed, so authoring mistakes fail at mount time
 *   instead of silently producing a tool the model cannot call correctly.
 */
export function defineTool(options) {
  if (typeof options.name !== "string" || options.name === "") {
    throw new Error("defineTool: name is required");
  }
  if (typeof options.description !== "string" || options.description === "") {
    throw new Error(`defineTool(${options.name}): description is required`);
  }
  if (options.output === undefined || typeof options.output.render !== "function") {
    throw new Error(`defineTool(${options.name}): output.render is required`);
  }

  const schemaViolations = [];
  const parameters = compileParameters(options.parameters, schemaViolations);
  const outputSchema = compileValueSchema(options.output.schema, schemaViolations, "output.schema");

  if (schemaViolations.length > 0) {
    throw new Error(`defineTool(${options.name}): invalid schema — ${schemaViolations.join("; ")}`);
  }

  for (const key of Object.keys(outputSchema)) {
    if (!ALLOWED_NODE_KEYS.has(key)) {
      throw new Error(`defineTool(${options.name}): output.schema uses unsupported keyword "${key}"`);
    }
  }

  const userExecute = options.execute;
  const userRender = options.output.render;
  const userConcurrency = options.isConcurrencySafe;

  const definition = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return userRender(args, value);
      },
    },
    async execute(args, exec) {
      const violations = validateArgs(parameters, args);
      if (violations.length > 0) {
        throw new Error(`${options.name}: invalid arguments — ${violations.join("; ")}`);
      }
      return await userExecute(args ?? {}, exec);
    },
  };

  if (userConcurrency !== undefined) {
    definition.isConcurrencySafe = (args) => userConcurrency(args) === true;
  }
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
    }
    definition.timeoutMs = options.timeoutMs;
  }

  return definition;
}
