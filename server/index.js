#!/usr/bin/env node
// Trustabl MCP server — exposes the Trustabl agent-safety scanner as tools the
// Cursor agent can call.
//
//   trustabl_scan           run a scan, return findings, write SARIF + JSON
//   trustabl_last_findings  re-read the SARIF from the previous scan
//
// stdout is reserved for the MCP protocol; all logging goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { ensureTrustabl } from "./trustabl-bin.js";

const SARIF_FILE = "trustabl.sarif";
const JSON_FILE = "trustabl.json";
const REPORT_FILE = "trustabl-report.txt";
// Lines of the console report to embed in the reply; the rest stays in the file.
const REPORT_EXCERPT_LINES = 40;
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
// A large repo can produce hundreds of findings; sending them all would swamp
// the agent's context. Return the worst ones and point at the files for the rest.
const MAX_FINDINGS_RETURNED = 50;
// Scan output is read from stdout, so allow for a big SARIF document.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const log = (msg) => process.stderr.write(`[trustabl] ${msg}\n`);
const textResult = (text, isError = false) => ({ content: [{ type: "text", text }], isError });

/**
 * One scan pass that produces everything: the human-readable report on stdout,
 * plus the JSON and SARIF files via --json-out/--sarif-out. Scanning is the slow
 * part, so running it once rather than once per format matters — a large repo can
 * otherwise take longer than an MCP client is willing to wait.
 */
function runScan(bin, target, { detectors, strict, sarifPath, jsonPath }) {
  const args = ["scan", target, "--format", "human", "--sarif-out", sarifPath, "--json-out", jsonPath];
  if (detectors) args.push("--detectors", detectors);
  if (strict) args.push("--strict");

  const r = spawnSync(bin, args, { maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" });
  if (r.error) throw new Error(`Failed to run trustabl: ${r.error.message}`);
  return { stdout: r.stdout ?? "", code: r.status, stderr: r.stderr ?? "" };
}

/** The console report is colored for a terminal; chat wants it plain. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, "");

/**
 * The full console report enumerates every finding — hundreds of KB on a large
 * repo, far more than belongs in a chat reply. Embed the summary at the top and
 * leave the rest in trustabl-report.txt.
 */
function reportExcerpt(report) {
  const lines = report.split("\n");
  if (lines.length <= REPORT_EXCERPT_LINES) return report;
  return [
    ...lines.slice(0, REPORT_EXCERPT_LINES),
    "",
    `... ${lines.length - REPORT_EXCERPT_LINES} more lines — full report in ${REPORT_FILE}`,
  ].join("\n");
}

function severityTable(bySeverity, total) {
  const rows = ["critical", "high", "medium", "low", "info"]
    .map((sev) => {
      const n = bySeverity[sev] ?? 0;
      const bar = "█".repeat(total ? Math.round((n / total) * 20) : 0);
      return `| ${sev.padEnd(8)} | ${String(n).padStart(5)} | ${bar}`;
    })
    .join("\n");
  return `| severity | count | share\n|----------|-------|------\n${rows}\n| **total**| ${String(total).padStart(5)} |`;
}

function maxSeverity(findings) {
  return findings.reduce(
    (worst, f) =>
      (SEVERITY_RANK[f.severity] ?? -1) > (SEVERITY_RANK[worst] ?? -1) ? f.severity : worst,
    "none"
  );
}

const server = new McpServer({ name: "trustabl", version: "0.1.0" });

server.registerTool(
  "trustabl_scan",
  {
    title: "Scan for AI-agent safety & reliability issues",
    description:
      "Run the Trustabl static scanner over a directory of AI-agent code. Detects agents, " +
      "tools, and MCP servers across Claude Agent SDK, OpenAI Agents, Google ADK, LangChain, " +
      "CrewAI, Pydantic AI and more, then reports risky patterns with severities and a " +
      "production-readiness score. Writes trustabl.sarif (SARIF 2.1.0) and trustabl.json " +
      "into the scanned directory, and returns the findings.",
    inputSchema: {
      path: z
        .string()
        .optional()
        .describe("Directory to scan. Defaults to the current workspace directory."),
      detectors: z
        .string()
        .optional()
        .describe("Comma-separated SDK subset, e.g. 'claude_sdk,openai_sdk,mcp'. Default: all."),
      strict: z.boolean().optional().describe("Report any finding, however minor."),
    },
  },
  async ({ path: target, detectors, strict }) => {
    const dir = path.resolve(target || process.cwd());
    if (!fs.existsSync(dir)) return textResult(`Path does not exist: ${dir}`, true);

    let bin;
    try {
      bin = await ensureTrustabl(process.env.TRUSTABL_VERSION);
    } catch (err) {
      return textResult(`Could not install the trustabl binary: ${err.message}`, true);
    }

    const sarifPath = path.join(dir, SARIF_FILE);
    const jsonPath = path.join(dir, JSON_FILE);

    let scan;
    try {
      scan = runScan(bin, dir, { detectors, strict, sarifPath, jsonPath });
    } catch (err) {
      return textResult(err.message, true);
    }

    // trustabl exits 1 when it gates on findings — that is a result, not a failure.
    // Exit 2 means the scanner itself errored.
    if (scan.code === 2) {
      return textResult(`trustabl failed to scan ${dir}:\n${scan.stderr}`, true);
    }

    let result;
    try {
      result = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    } catch {
      return textResult(`trustabl produced no parseable JSON report.\n${scan.stderr}`, true);
    }

    const findings = result.findings ?? [];
    const readiness = Math.round(Math.min(1, Math.max(0, result.overall_score ?? 1)) * 100);
    const bySeverity = findings.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    }, {});
    const worst = [...findings].sort(
      (a, b) => (SEVERITY_RANK[b.severity] ?? -1) - (SEVERITY_RANK[a.severity] ?? -1)
    );
    const returned = worst.slice(0, MAX_FINDINGS_RETURNED);

    const summary = {
      scanned: dir,
      readiness_score: readiness,
      risk_score: 100 - readiness,
      findings_total: findings.length,
      max_severity: maxSeverity(findings),
      by_severity: bySeverity,
      detected_sdks: result.sdks ?? [],
      files_parsed: result.coverage?.files_parsed ?? 0,
      gated: scan.code === 1,
      sarif_file: sarifPath,
      json_file: jsonPath,
      findings_returned: returned.length,
      findings_truncated: findings.length - returned.length,
    };

    // Persist the console report too, so it can be read back or pasted into a ticket.
    const report = stripAnsi(scan.stdout).trimEnd();
    const reportPath = path.join(dir, REPORT_FILE);
    try {
      fs.writeFileSync(reportPath, `${report}\n`);
      summary.report_file = reportPath;
    } catch (err) {
      log(`could not write ${REPORT_FILE}: ${err.message}`);
    }

    return textResult(
      [
        `## Trustabl scan — ${dir}`,
        "",
        `**Readiness ${readiness}/100** · risk ${100 - readiness} · ` +
          `${findings.length} findings · max severity \`${summary.max_severity}\`` +
          (summary.gated ? " · **gated** (medium or higher)" : ""),
        "",
        severityTable(bySeverity, findings.length),
        "",
        "```",
        reportExcerpt(report),
        "```",
        "",
        `Reports written: \`${SARIF_FILE}\`, \`${JSON_FILE}\`, \`${REPORT_FILE}\``,
        "",
        `### Details`,
        "```json",
        JSON.stringify(summary, null, 2),
        "```",
        "",
        `### Findings (worst first, ${returned.length} of ${findings.length})`,
        "```json",
        JSON.stringify(returned, null, 2),
        "```",
      ].join("\n")
    );
  }
);

server.registerTool(
  "trustabl_last_findings",
  {
    title: "Read the last Trustabl SARIF report",
    description:
      "Return the SARIF report written by the most recent trustabl_scan in a directory, " +
      "without re-running the scan.",
    inputSchema: {
      path: z
        .string()
        .optional()
        .describe("Directory containing trustabl.sarif. Defaults to the current directory."),
    },
  },
  async ({ path: target }) => {
    const sarifPath = path.join(path.resolve(target || process.cwd()), SARIF_FILE);
    if (!fs.existsSync(sarifPath)) {
      return textResult(`No ${SARIF_FILE} found at ${sarifPath}. Run trustabl_scan first.`, true);
    }
    return textResult(fs.readFileSync(sarifPath, "utf8"));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP server ready");
