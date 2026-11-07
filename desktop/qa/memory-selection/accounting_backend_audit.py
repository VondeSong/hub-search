"""Read-only audit of remaining HBM-00 gates; no model, build, vault or production writes."""
from datetime import datetime,timezone
import importlib.metadata as metadata
import json
from pathlib import Path
import sys
from accounting_support import ROOT,REPORTS,save,digest

dist=metadata.distribution('basic-memory')
meta={key:dist.metadata.get_all(key) for key in ['Name','Version','Requires-Python','License','License-Expression','License-File','Project-URL']}
licenses=[]
for entry in dist.files or []:
    if 'dist-info/licenses/' in str(entry).replace('\\','/'):
        path=Path(dist.locate_file(entry))
        if path.is_file():
            licenses.append({'relativePath':str(entry),'sha256':digest(path),'firstLine':path.read_text(encoding='utf-8').strip().splitlines()[0]})
config_path=ROOT/'src-tauri/tauri.conf.json'
tauri=json.loads(config_path.read_text(encoding='utf-8'))
native_path=ROOT/'src-tauri/src/agent_work/memory_selection_tests.rs'
native=native_path.read_text(encoding='utf-8')
old=ROOT/'artifacts/hbm-00-20261018'
soak=json.loads((old/'basic-memory-hybrid-soak-1792296937.json').read_text(encoding='utf-8'))
save('backend-gate-readiness.json',{'at':datetime.now(timezone.utc).isoformat(),'operation':'read_only_remaining_gate_audit',
 'runtime':{'python':sys.version,'executable':sys.executable,'packageMetadata':meta,'licenses':licenses,
            'requirementsSha256':digest(old/'requirements.freeze.txt')},
 'packaging':{'tauriConfigSha256':digest(config_path),'bundleExternalBin':tauri['bundle'].get('externalBin'),
              'bundleResources':tauri['bundle'].get('resources'),
              'conclusion':'Current manifest has no packaged Basic Memory/Python/model sidecar. The isolated virtual environment is not an installed-app runtime acceptance.'},
 'nativeParity':{'sourceSha256':digest(native_path),'fixedOriginalCorpusPath':'qa/memory-selection/corpus.json' in native,
                 'fixed60Queries':'assert_eq!(questions.len(), 60)' in native,'fullBodyReadCap3000':'0, 3000' in native,
                 'same266Record140QueryFixtureSupportedAsIs':False,
                 'conclusion':'Existing native test is original-60-query SQLite/Tantivy evidence, not this passage/vector + applicability pipeline. Need an isolated adapter with same corpus, source/state authority, splitting, embedding and injection budget; keep retrieval backend and representation improvements separate.'},
 'priorSoak':{'path':str(old/'basic-memory-hybrid-soak-1792296937.json'),'sha256':digest(old/'basic-memory-hybrid-soak-1792296937.json'),
              'status':soak['status'],'topLevelKeys':list(soak),'countsAs24HourEvidence':False},
 'remainingOrder':[
  {'gate':'same-condition backend comparison','accept':'Frozen same permitted corpus, project/status filtering, canonical identity, token passages and embedding; exact lexical/semantic layers named. Compare native and Basic Memory, no memory baseline separately; same model/injection budget. Reuse this holdout only as observed regression, not new unseen evidence.'},
  {'gate':'lifecycle consistency','accept':'Sandbox update/replacement/delete, full forgetting including derived summaries, crash boundaries and restart/rebuild/backup restore. Deleted/retired/candidate/other-project bodies never reach model. Include Windows external-file edits and body hash mismatch.'},
  {'gate':'real task usefulness','accept':'20 predefined bounded tasks, matched memory on/off, >=18 useful and zero critical memory-caused factual errors; independent label review if available. This round selected evidence only, generated no final task answers.'},
  {'gate':'Windows managed runtime and startup','accept':'Pinned Python/package/models and integrity/version manifest, promos/update/diagnostics off, install/recovery/upgrade/removal; first download separate, post-install service cold target <=10 sec without UI blocking. Current experiment is not packaged.'},
  {'gate':'24-hour bounded observation','accept':'Separate preregistered workload, project scale and resource budget; warm RSS <=1536 MiB, final growth <=10%, managed disk <=8GiB, free disk >=10GiB, no increasing process count, owned children stop. Actual full 24h required, no unattended run started by this audit.'},
  {'gate':'distribution terms','accept':'Review actual pinned package license and intended distribution mode before adopting a bundled runtime. This is a remaining assessment, not a legal compliance conclusion.'}],
 'latencyOptimizationTrack':'closed_after_current_frozen_run_no_further_tuning',
 'backendDecision':'undecided','productionWrites':0,'modelCalls':0,'laterBatchesStarted':False})
print(json.dumps({'basicMemory':dist.version,'python':sys.version.split()[0],'metadata':meta,'license':licenses,
                  'nativeSameFixtureSupported':False,'packagedSidecar':False},ensure_ascii=False))
