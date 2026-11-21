// Model adapters. The agent only needs: respond({ system, messages, tools }) -> { content: [blocks] }.
// 1. anthropicModel: the real thing, plain fetch to the Messages API, no SDK.
// 2. mockModel: scripted models used to test the eval harness itself without any API calls.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load ANTHROPIC_API_KEY from agent-evals/.env if it is not already in the environment. The file is git-ignored.
(function loadDotEnv() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(ANTHROPIC_API_KEY|GEMINI_API_KEY)\s*=\s*(.+?)\s*$/);
    // Only fill variables that are not set at all; a variable set to an empty string on purpose stays empty.
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

// Gemini adapter (untested until it is run with a real key). Converts our Anthropic-style messages to Gemini's format.
// Gemini 3 models require the model's own function-call parts (with their thought signatures) to be sent back unchanged,
// so each tool_use block keeps the raw part in `raw`.
export function geminiModel(name, apiKey = process.env.GEMINI_API_KEY) {
  if (!apiKey) throw new Error('Set GEMINI_API_KEY to run a Gemini model.');
  const toContents = (messages) => {
    const names = {};
    const contents = [];
    for (const m of messages) {
      if (typeof m.content === 'string') { contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }); continue; }
      if (m.role === 'assistant') {
        const parts = m.content.map((b) => {
          if (b.type === 'text') return { text: b.text };
          names[b.id] = b.name;
          return b.raw ?? { functionCall: { name: b.name, args: b.input } };
        });
        contents.push({ role: 'model', parts });
      } else {
        contents.push({
          role: 'user',
          parts: m.content.map((b) => ({ functionResponse: { name: names[b.tool_use_id], response: b.is_error ? { error: b.content } : { output: b.content } } })),
        });
      }
    }
    return contents;
  };
  return {
    name,
    async respond({ system, messages, tools }) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: toContents(messages),
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }],
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      };
      let lastError = '';
      for (let attempt = 0; attempt < 8; attempt++) {
        // Space requests out so a per-minute rate limit is rarely hit (default about 13 requests per minute).
        const gap = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 4500);
        const wait = geminiModel.nextSlot - Date.now();
        geminiModel.nextSlot = Math.max(Date.now(), geminiModel.nextSlot) + gap;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        let res;
        try {
          res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${name}:generateContent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120000),
          });
        } catch (e) {
          lastError = `request ${e.name === 'TimeoutError' ? 'timed out after 120s' : e.message}`;
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          const text = (await res.text()).slice(0, 300).replace(/\s+/g, ' ');
          lastError = `${res.status} ${text.slice(0, 160)}`;
          // Rate limits (429) are per minute on this key: wait for the window to reset. Server errors back off shorter.
          const wait = res.status === 429 ? 20000 + 10000 * attempt : 2000 * 2 ** attempt;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 400)}`);
        const json = await res.json();
        const parts = json.candidates?.[0]?.content?.parts ?? [];
        const content = parts.map((p) => {
          if (p.functionCall) return { type: 'tool_use', id: `gem_${++counter}`, name: p.functionCall.name, input: p.functionCall.args ?? {}, raw: p };
          return { type: 'text', text: p.text ?? '' };
        });
        const u = json.usageMetadata ?? {};
        // finishReason explains an empty reply (for example MALFORMED_FUNCTION_CALL), which the agent records in its trace.
        return { content, stopReason: json.candidates?.[0]?.finishReason, usage: { input: u.promptTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) } };
      }
      throw new Error(`Gemini kept failing after retries. Last error: ${lastError}`);
    },
  };
}

let counter = 0;
const nextId = () => `toolu_mock_${++counter}`;

export function anthropicModel(name, apiKey = process.env.ANTHROPIC_API_KEY) {
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY to run a real model.');
  return {
    name,
    async respond({ system, messages, tools }) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: name, max_tokens: 2048, system, messages, tools }),
        });
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          continue;
        }
        if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const json = await res.json();
        return {
          content: json.content,
          stopReason: json.stop_reason,
          usage: { input: json.usage?.input_tokens ?? 0, output: json.usage?.output_tokens ?? 0 },
        };
      }
      throw new Error('API kept failing after retries');
    },
  };
}

geminiModel.nextSlot = 0; // earliest time the next Gemini request may be sent

// Scripted models replay the reference solution stored with each case.
//   mock-good:     performs the reference solution exactly.
//   mock-lazy:     skips the last operation (a typical "forgot a step" bug).
//   mock-reckless: also upper-cases a protected column nobody asked it to touch.
export function mockModel(kind) {
  return {
    name: kind,
    async respond({ messages, meta }) {
      const solution = meta?.solution;
      if (!solution) throw new Error('mock models need meta.solution (the reference solution of the case)');
      let ops = [...solution.ops];
      if (kind === 'mock-lazy' && ops.length > 0) ops = ops.slice(0, -1);
      if (kind === 'mock-reckless' && solution.protectedColumn) ops.push({ name: 'change_case', input: { column: solution.protectedColumn, mode: 'upper' } });
      const turn = messages.filter((m) => m.role === 'assistant').length;
      if (turn < ops.length) {
        return { content: [{ type: 'tool_use', id: nextId(), name: ops[turn].name, input: ops[turn].input }], usage: { input: 0, output: 0 } };
      }
      return { content: [{ type: 'tool_use', id: nextId(), name: 'finish', input: solution.finish }], usage: { input: 0, output: 0 } };
    },
  };
}
