#!/usr/bin/env node
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/server.js'
import { performanceFixture } from '../test/performance-fixture.js'
import { scenarios } from '../test/turn-scenarios.js'

const delayMs = 10
const samples = 3
const rows = []
for (const scenario of scenarios) {
  const row = { scenario: scenario.name }
  for (const variant of ['baseline', 'optimized']) {
    const runs = []
    for (let i = 0; i < samples; i++) {
      const f = performanceFixture({ delayMs, state: scenario.state })
      const start = performance.now()
      await scenario[variant](f)
      runs.push({ elapsed_ms: performance.now() - start, rounds: f.rounds, ...f.metrics })
    }
    runs.sort((a, b) => a.elapsed_ms - b.elapsed_ms)
    const median = runs[Math.floor(samples / 2)]
    row[variant] = { ...median, elapsed_ms: Number(median.elapsed_ms.toFixed(1)) }
  }
  rows.push(row)
}
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const server = createMcpServer(performanceFixture().api)
const client = new Client({ name: 'turn-benchmark', version: '1' })
await server.connect(serverTransport)
await client.connect(clientTransport)
const { tools } = await client.listTools()
const metadata = { tools: tools.length, metadata_bytes: Buffer.byteLength(JSON.stringify(tools)) }
await client.close()
await server.close()
const report = { method: 'Production tool handlers + production API client; simulated backend, no LLM, no real network. Baseline already parallelizes independent calls within each dependency phase. HTTP OAuth validation is outside this harness.',
  runtime: process.version, simulated_request_delay_ms: delayMs, samples, metadata, scenarios: rows }
const directory = new URL('../benchmarks/', import.meta.url)
fs.mkdirSync(directory, { recursive: true })
fs.writeFileSync(new URL('turn-performance.json', directory), JSON.stringify(report, null, 2) + '\n')
const lines = ['# MCP turn performance', '', report.method, '', `Runtime ${process.version}. Each API request has a simulated ${delayMs} ms delay; timings are medians of ${samples} runs.`,
  'A round is a scripted model/server dependency phase, not an observed LLM turn. Tool calls are separate invocations; independent calls in a baseline round run concurrently.', '',
  '| Scenario | Tool calls before → after | Dependency rounds before → after | API requests before → after | Median ms before → after |',
  '|---|---:|---:|---:|---:|']
for (const row of rows) lines.push(`| ${row.scenario} | ${row.baseline.tool_calls} → ${row.optimized.tool_calls} | ${row.baseline.rounds} → ${row.optimized.rounds} | ${row.baseline.api_requests} → ${row.optimized.api_requests} | ${row.baseline.elapsed_ms} → ${row.optimized.elapsed_ms} |`)
lines.push('', `The optimized server advertises ${metadata.tools} tools; its JSON tool metadata is ${metadata.metadata_bytes.toLocaleString('en-US')} bytes. Named API tools remove discovery turns at the cost of a larger initial tool catalogue. Their descriptions are summaries; full endpoint documentation remains on-demand.`, '',
  'Read batching reduces duplicated backend requests, not the minimum model round count for reads that a client could already issue in parallel. Combined writes and result references remove genuine dependency rounds. Timings exclude inference, OAuth validation, TLS, real providers, payload-scale effects and network variability; do not interpret them as measured ChatGPT latency.', '',
  'Re-run: `npm run benchmark:turns` from `mcp/`. The regression suite asserts call/request/round counts and concurrency bounds instead of fragile wall-clock thresholds.', '')
fs.writeFileSync(new URL('turn-performance.md', directory), lines.join('\n'))
console.log(lines.join('\n'))
