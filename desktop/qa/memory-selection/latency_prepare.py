"""Freeze scope, budget, ownership and development comparison before probes."""
import json
from datetime import datetime, timezone
from pathlib import Path
from latency_support import ROOT, WORK, PREVIOUS, save, digest
from passage_delivery import snapshot

if __name__ == '__main__':
    WORK.mkdir(parents=True, exist_ok=False)
    prior = json.loads((PREVIOUS / 'production-before.json').read_text(encoding='utf-8'))['files']
    production = snapshot()
    assert production == prior
    save('scope-contract.json', {
        'createdAt': datetime.now(timezone.utc).isoformat(),
        'root': str(ROOT), 'model': 'gpt-6.1-sol', 'effort': 'xhigh',
        'result': 'Decompose selection latency, compare bounded persistent options on development only, freeze method then one new validation.',
        'route': 'performance/root cause plus external protocol compatibility',
        'allowed': ['new QA adapters and tests', 'isolated temporary app-server processes', 'actual model calls', 'new synthetic frozen fixture', 'existing implementation plan and QA README'],
        'forbidden': ['production code changes', 'backend choice', 'later HBM batches', 'global user config changes', 'new packages or model downloads', 'private user library access', 'paid-tier changes', 'deleting old evidence'],
        'owners': {'qa/memory-selection/latency_*.py': 'experiment sources', str(WORK): 'owned runtime/protocol schema/canonical/index/transcripts',
                   'artifacts/hbm-00-latency-20261018': 'immutable contracts and receipts', 'docs/INSIGHTS_IMPLEMENTATION_PLAN.md': 'sole plan'},
        'retention': 'Keep experiment evidence for review, no automatic deletion; all owned processes close before delivery.',
        'budgets': {'preflightModelCallsMax': 4, 'developmentModelCallsMax': 48, 'validationQuestions': 80,
                    'validationExecutionsMax': 1, 'callTimeoutSeconds': 120, 'explicitRetries': 0,
                    'newDiskBytesMax': 150_000_000, 'noPackageInstall': True},
        'timing': ['process spawn to initialize ready', 'fresh thread setup', 'turn submit to first observable event',
                   'first reasoning event if available', 'first answer delta', 'turn complete', 'host validation and cleanup'],
        'attributionLimit': 'No interception of TLS/authentication. Network+server queue+prefill+hidden inference cannot be separated without server telemetry. TTFT is not network latency, reasoning token count is not reasoning duration.',
        'development': {'source': str(PREVIOUS), 'selection': 'First 12 opaque-id-sorted cases, same frozen top-five payload in all modes; alternate mode order per case.',
                        'modes': ['fresh CLI', 'fresh app-server', 'persistent app-server with fresh independent threads', 'persistent session with verified empty history only if protocol supports it'],
                        'selectionRule': 'Discard modes with protocol/quote/outcome disagreement or history leakage. Choose lowest paired median complete duration; only call improvement demonstrated if median paired saving >=10% and >=8/12 cases improve. Otherwise keep original and report no demonstrated improvement.'},
        'validation': {'newFactsAfterMethodFreeze': True, 'positive': 40, 'negative': 40,
                       'gates': {'candidateRecallAt5': .9, 'selectedRecall': .9, 'negativeFalseSelections': 0,
                                 'selectedPrecision': .8, 'invalidDecisions': 0, 'scopeStateViolations': 0},
                       'postFreezeTuning': False, 'postFreezeLabelChanges': False},
        'production': production, 'oldMethodSha256': digest(PREVIOUS / 'method-contract.json'),
        'stop': 'Local QA/report delivery; HBM-00 overall open, backend undecided, no production integration.'})
    print(json.dumps({'productionFiles': len(production), 'unchanged': True}))
