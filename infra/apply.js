#!/usr/bin/env node
//
// infra/workflows.json 을 Dataform 에 적용한다.
//
//   node infra/apply.js --dry-run   차이만 보여준다
//   node infra/apply.js             적용한다
//
// Dataform 의 release/workflow configuration 은 GCP 리소스라 git 에 남지 않는다.
// 선언을 원천으로 두고 이 스크립트가 맞춘다.
//
// PATCH 는 invocationConfig 같은 중첩 필드를 갱신하지 못한다. 그래서 workflow
// configuration 이 달라지면 지우고 다시 만든다 — 스케줄 정의일 뿐 데이터가 아니라
// 재생성해도 잃는 것이 없다.
//
// 인증은 gcloud 의 사용자 자격을 쓴다. 실행 계정(serviceAccount)은 선언에 적고,
// 이 스크립트를 돌리는 사람에게는 Dataform 편집 권한만 있으면 된다.

const { execFileSync } = require("child_process");
const fs   = require("fs");
const path = require("path");

const DRY  = process.argv.includes("--dry-run");
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, "workflows.json"), "utf8"));
const BASE = `https://dataform.googleapis.com/v1beta1/projects/${SPEC.project}` +
             `/locations/${SPEC.location}/repositories/${SPEC.repository}`;

const token = () =>
  execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();

// _comment 는 사람이 읽는 것이라 API 로 보내지 않는다
const strip = (o) =>
  Array.isArray(o) ? o.map(strip)
  : o && typeof o === "object"
    ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== "_comment").map(([k, v]) => [k, strip(v)]))
    : o;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (json.error) throw new Error(`${method} ${url.split("/").pop()}: ${json.error.message}`);
  return json;
}

// 선언과 현재 상태를 비교한다. 선언에 없는 필드는 서버가 채운 것이라 보지 않는다.
// API 는 기본값(false · {} · [])을 응답에서 생략하므로 없는 것과 같게 본다 —
// 안 그러면 선언에 false 를 명시할 때마다 매번 차이로 잡힌다
const isDefault = (v) =>
  v === false || v === undefined ||
  (v && typeof v === "object" && Object.keys(v).length === 0);

const differs = (want, have) =>
  Object.entries(want).some(([k, v]) => {
    const h = have?.[k];
    if (isDefault(v) && isDefault(h)) return false;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? differs(v, h || {})
      : JSON.stringify(v) !== JSON.stringify(h);
  });

let TOKEN;

async function main() {
  TOKEN = token();
  let changed = 0;

  // ── release configuration ───────────────────────────────
  const haveR = (await api("GET", `${BASE}/releaseConfigs`)).releaseConfigs || [];
  for (const [id, raw] of Object.entries(SPEC.releaseConfigs)) {
    const want = strip(raw);
    const cur  = haveR.find((r) => r.name.endsWith(`/${id}`));

    if (cur && !differs(want, cur)) { console.log(`  = releaseConfig/${id}`); continue; }
    changed++;
    console.log(`  ${cur ? "~" : "+"} releaseConfig/${id}  ${want.cronSchedule} ${want.timeZone}`);
    if (DRY) continue;

    if (cur) await api("PATCH", `${BASE}/releaseConfigs/${id}?updateMask=cronSchedule,timeZone,gitCommitish`, want);
    else     await api("POST",  `${BASE}/releaseConfigs?releaseConfigId=${id}`, want);
  }

  // ── workflow configuration ──────────────────────────────
  const haveW = (await api("GET", `${BASE}/workflowConfigs`)).workflowConfigs || [];
  for (const [id, raw] of Object.entries(SPEC.workflowConfigs)) {
    const want = strip(raw);
    // 선언에는 release config 를 짧은 이름으로 적고 여기서 펼친다
    want.releaseConfig = `projects/${SPEC.project}/locations/${SPEC.location}` +
                         `/repositories/${SPEC.repository}/releaseConfigs/${want.releaseConfig}`;
    const cur = haveW.find((w) => w.name.endsWith(`/${id}`));

    if (cur && !differs(want, cur)) { console.log(`  = workflowConfig/${id}`); continue; }
    changed++;
    const tags = want.invocationConfig.includedTags.join(" ");
    console.log(`  ${cur ? "~" : "+"} workflowConfig/${id}  ${want.cronSchedule} ${want.timeZone}  [${tags}]`);
    if (DRY) continue;

    // PATCH 가 중첩 필드를 갱신하지 못해 지우고 다시 만든다
    if (cur) await api("DELETE", `${BASE}/workflowConfigs/${id}`);
    await api("POST", `${BASE}/workflowConfigs?workflowConfigId=${id}`, want);
  }

  // ── 선언에 없는데 남아 있는 것 ──────────────────────────
  for (const r of haveR) {
    const id = r.name.split("/").pop();
    if (!(id in SPEC.releaseConfigs)) console.log(`  ! releaseConfig/${id} 는 선언에 없다 (수동 확인)`);
  }
  for (const w of haveW) {
    const id = w.name.split("/").pop();
    if (!(id in SPEC.workflowConfigs)) console.log(`  ! workflowConfig/${id} 는 선언에 없다 (수동 확인)`);
  }

  console.log(changed === 0 ? "\n선언과 일치한다." : DRY ? `\n${changed}건 차이. --dry-run 없이 실행하면 적용된다.` : `\n${changed}건 적용했다.`);
}

main().catch((e) => { console.error("실패:", e.message); process.exit(1); });
