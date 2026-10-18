/**
 * A JSON-schema form (ACP `elicitation/create`, Codex `mcpServer/elicitation/
 * request`) as questions for the user, and the answers back as the form's
 * content. Both protocols carry the MCP `requestedSchema` shape: flat
 * properties of string / enum / oneOf / number / boolean / array-of-enum.
 *
 * claude-agent-acp's AskUserQuestion is such a form, with one extra
 * convention read from its source (elicitation.js): `question_<n>` is the
 * select and an optional `question_<n>_custom` string beside it is that
 * question's own "Other" box. A property named `<key>_custom` next to a
 * select property `<key>` is therefore folded into the select as free text,
 * and the typed text is written back to the companion field.
 */
import type { HarnessQuestion, HarnessQuestionAnswers, HarnessQuestionRequest } from './question.js';

type Json = Record<string, any>;

interface Field {
  key: string;
  kind: 'select' | 'multi' | 'boolean' | 'number' | 'text';
  /** label -> the value the form wants for it. */
  values: Map<string, string>;
  /** The companion free-text property (`<key>_custom`), if the form has one. */
  custom?: string;
  integer?: boolean;
}

interface FormQuestions {
  request: HarnessQuestionRequest;
  /** The form's `content` for an answered request. */
  content(answers: HarnessQuestionAnswers): Record<string, string | number | boolean | string[]>;
}

const SECRET_NAME = /pass(word|phrase)|secret|token|api[-_ ]?key/i;

function optionsOf(schema: Json): { label: string; value: string; description?: string }[] | undefined {
  const named = (list: unknown, constKey: 'const' | 'value'): { label: string; value: string; description?: string }[] | undefined => {
    if (!Array.isArray(list) || !list.length) return undefined;
    const out: { label: string; value: string; description?: string }[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || entry[constKey] === undefined) return undefined;
      const value = String(entry[constKey]);
      out.push({ value, label: typeof entry.title === 'string' && entry.title ? entry.title : value, ...(typeof entry.description === 'string' && entry.description ? { description: entry.description } : {}) });
    }
    return out;
  };
  const oneOf = named(schema.oneOf, 'const') ?? named(schema.anyOf, 'const');
  if (oneOf) return oneOf;
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const names: unknown[] = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.map((value: unknown, index: number) => ({ value: String(value), label: typeof names[index] === 'string' && names[index] ? String(names[index]) : String(value) }));
  }
  return undefined;
}

/** The form as questions. Undefined when it has nothing a person could fill in. */
export function formToQuestions(message: string, schema: unknown, title: string): FormQuestions | undefined {
  const properties: Json = schema && typeof schema === 'object' && (schema as Json).properties && typeof (schema as Json).properties === 'object'
    ? (schema as Json).properties : {};
  const required = new Set<string>(Array.isArray((schema as Json | undefined)?.required) ? (schema as Json).required.map(String) : []);
  const keys = Object.keys(properties);
  const selectLike = (key: string): boolean => {
    const p = properties[key];
    return Boolean(p) && (p.type === 'array' ? optionsOf(p.items ?? {}) !== undefined : optionsOf(p) !== undefined);
  };
  const companions = new Set(keys.filter((key) => key.endsWith('_custom') && selectLike(key.slice(0, -'_custom'.length)) && properties[key]?.type === 'string' && !optionsOf(properties[key]!)));
  const fields: Field[] = [];
  const questions: HarnessQuestion[] = [];
  const single = keys.length - companions.size === 1;
  for (const key of keys) {
    if (companions.has(key)) continue;
    const p: Json = properties[key] ?? {};
    const heading = typeof p.title === 'string' && p.title ? p.title : undefined;
    const description = typeof p.description === 'string' && p.description ? p.description : undefined;
    const prompt = description ?? (single && message ? message : heading ?? key);
    const header = heading && heading !== prompt ? heading : undefined;
    const base = { id: key, ...(header ? { header } : {}), prompt, ...(required.has(key) ? {} : { optional: true }) };
    const customKey = companions.has(`${key}_custom`) ? `${key}_custom` : undefined;
    const choices = p.type === 'array' ? optionsOf(p.items ?? {}) : optionsOf(p);
    if (choices) {
      const multi = p.type === 'array';
      fields.push({ key, kind: multi ? 'multi' : 'select', values: new Map(choices.map((c) => [c.label, c.value])), ...(customKey ? { custom: customKey } : {}) });
      questions.push({
        ...base, multiSelect: multi, allowFreeText: customKey !== undefined,
        options: choices.map((c) => ({ label: c.label, ...(c.description ? { description: c.description } : {}) })),
      });
    } else if (p.type === 'boolean') {
      fields.push({ key, kind: 'boolean', values: new Map([['Yes', 'true'], ['No', 'false']]) });
      questions.push({ ...base, options: [{ label: 'Yes' }, { label: 'No' }] });
    } else if (p.type === 'number' || p.type === 'integer') {
      fields.push({ key, kind: 'number', values: new Map(), integer: p.type === 'integer' });
      questions.push({ ...base, options: [], allowFreeText: true });
    } else {
      fields.push({ key, kind: 'text', values: new Map() });
      questions.push({ ...base, options: [], allowFreeText: true, ...(p.format === 'password' || SECRET_NAME.test(`${key} ${heading ?? ''}`) ? { secret: true } : {}) });
    }
  }
  if (!questions.length) return undefined;
  return {
    request: { title: message && !single ? message : title, questions },
    content(answers) {
      const content: Record<string, string | number | boolean | string[]> = {};
      for (const field of fields) {
        const given = answers[field.key]?.filter((v) => v !== '');
        if (!given?.length) continue;
        if (field.kind === 'multi' || field.kind === 'select') {
          const picked = given.filter((v) => field.values.has(v)).map((v) => field.values.get(v)!);
          const typed = given.filter((v) => !field.values.has(v));
          if (field.kind === 'multi') { if (picked.length) content[field.key] = picked; }
          else if (picked.length) content[field.key] = picked[0]!;
          if (typed.length && field.custom) content[field.custom] = typed.join(', ');
        } else if (field.kind === 'boolean') {
          content[field.key] = field.values.get(given[0]!) === 'true';
        } else if (field.kind === 'number') {
          const n = Number(given[0]);
          if (Number.isFinite(n)) content[field.key] = field.integer ? Math.trunc(n) : n;
        } else content[field.key] = given[0]!;
      }
      return content;
    },
  };
}
