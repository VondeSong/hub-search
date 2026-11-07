"""Register scope BEFORE selecting new source notes or authoring questions."""
from parity_support import *

if __name__ == '__main__':
    WORK.mkdir(parents=True, exist_ok=False)
    HOME.mkdir()
    (WORK / 'tmp').mkdir()
    (WORK / 'shared-cwd').mkdir()
    previous = ROOT / 'artifacts/hbm-00-parity-20261018'
    preflight = json.loads((previous/'preflight.json').read_text(encoding='utf-8'))
    assert preflight['status']=='completed'
    preflight['reusedFrom']={'path':str(previous/'preflight.json'),'sha256':digest(previous/'preflight.json'),
                           'reason':'Only prospective source sampling changed; no model/policy/retrieval/embedding change or repeated preflight calls.'}
    save('preflight.json',preflight)
    save('native-harness.json',json.loads((previous/'native-harness.json').read_text(encoding='utf-8')))
    save('scope-contract.json', {
        'registeredAt': now(), 'model': MODEL, 'effort': EFFORT,
        'result': 'HBM-00 same-condition native SQLite/Tantivy/vector prototype versus Basic Memory; new real-note holdout.',
        'allowed': ['New parity QA files', 'Test-only opt-in native adapter', 'Owned runtime and evidence',
                    'Read-only new OS note snapshots', 'Existing canonical implementation plan and QA README'],
        'forbidden': ['Production memory integration or schema change', 'Backend adoption', 'Latency optimization',
                      'Public authentication probes or new consent', 'Later HBM batches', 'Original vault writes',
                      'New packages or embedding models', 'Post-validation tuning'],
        'ownership': {'runtime': str(WORK), 'evidence': str(REPORTS), 'vault': 'Read only; copies remain under owned runtime'},
        'comparison': {
            'primary': ['hub-native-hybrid', 'basic-memory-hybrid'],
            'native': 'Actual Hub SQLite/Tantivy/EvidenceReader lexical retrieval + isolated Python sqlite-vec/FastEmbed prototype; Rust embedding integration is NOT implemented.',
            'basicMemory': 'Actual local Basic Memory MCP vector service, with the SAME Hub lexical results and host adapter.',
            'common': ['Source bytes, title, exact passage boundaries', 'Pinned Chinese BGE small 512-dimensional weights',
                       'Same semantic subchunks and normalized embedding inputs', 'Top-50 lexical passages and vector entities; parent dedup; RRF60; parent20; final5',
                       'Host-owned project/state/body identity filters', 'Same passage selection and injection budget',
                       'Same policy/schema/model/effort, fresh empty history each call'],
            'interpretation': 'Isolates the vector service/storage contribution under a shared Hub adapter. Does not compare standalone Basic Memory full-text/graph capabilities or prove native packaging.',
            'supplementary': ['Hub lexical-only retrieval, no additional model calls', 'Vector-only raw ranks', 'Common-adapter contribution and exact candidate equality'],
        },
        'method': {
            'split': 'Existing paragraph-first BGE tokenizer windows 256 tokens with overlap32; full original note, no source head truncation.',
            'embeddingRepresentation': 'Basic Memory published semantic chunk algorithm applied to title + opaque passage permalink + exact passage. Audit actual persisted BM entity chunk texts before any validation query.',
            'nativeVectors': 'Independently embed identical semantic input strings with cached FastEmbed, normalized, sqlite-vec L2; no BM stored vectors copied.',
            'queries': 'Original natural question to vector search. Generic existing jieba search terms to shared production Tantivy; no topic maps or title expansion.',
            'candidates': 'Keep actual fused rank; one best source passage per top5 parent by equal RRF60 of lexical/vector passage ranks, stable opaque-id ties. No label-aware excerpts or presentation rotation.',
            'budget': 'At most 5 source passages, <=2000 pinned BGE tokens for serialized memories. This is a shared tokenizer proxy, not proof of exact Sol production-token accounting.',
            'policy': 'Reuse existing applicability_policy unchanged. No new threshold, model, reranker, prompt or query tuning.',
            'execution': 'One retrieval pass/backend. Per question alternate backend model order, independent histories. Identical byte-for-byte prompts may share ONE judgement; report shared rows and actual call costs.',
            'failure': 'Preserve any failure; no explicit model retry, validation rewrite or second run. Infrastructure repair before holdout retrieval must be disclosed.',
        },
        'newData': {
            'clusters': ['Areas/结构学', 'Resources/图书', 'Areas/数字自我'],
            'fallbackClusters': [],
            'sampling': 'Per cluster, full UTF-8 Markdown with 700-18000 Unicode characters, no NUL, exclude previous positive source paths, opaque SHA256(path) order, first16. Fallback only if a cluster has fewer than8 eligible notes; record inventory before questions.',
            'realNotesTarget': 48, 'minimumRealNotes': 24, 'positive': 24, 'negative': 100,
            'authorship': 'Primary agent reads and authors/audits 24 positives from 12 real notes plus 100 absent-detail/scope/event/ambiguity negatives. Judge Sol/xhigh, same family, NOT independent annotation.',
            'coverage': 'At least12 positive supports after1024 source BGE tokens, where available; question does not contain the exact source filename stem. Include weak paraphrases, competing adjacent concepts, partial condition versus event, omitted details, ambiguity and cross-project/state guards.',
            'tailQualification': 'Across either primary backend, >=6/24 positives have best acceptable gold parent rank>1, including >=2 rank>5 or missing. Otherwise report actual retrieval-tail coverage NOT demonstrated; never edit questions to meet this after retrieval.',
        },
        'gates': {'candidateRecallAt5': .90, 'selectedRecall': .90, 'selectedPrecision': .80,
                  'negativeFalseSelections': 0, 'invalidDecisions': 0, 'scopeStateViolations': 0},
        'scoring': 'Any frozen acceptable source ID; positive success requires the exact frozen evidence span present in selected original-source quote or quote overlaps the frozen evidence span with all quoted text verified. Quote semantics reviewed separately without relabeling. Candidate and evidence-span coverage separate.',
        'negativeUpperBound': 'Zero/100: one-sided95% IID binomial upper bound 1-0.05**(1/100)=2.95%; related same-author cases weaken generalization.',
        'cost': 'All observed formal/preflight/prewarm/final-unused requests, input/cached/output/reasoning/total tokens and native event timestamps. Include full batch wall, index and shutdown separately; no reuse/latency claim.',
        'budget': {'formalQuestionsPerBackend': 124, 'formalModelCallsMax': 248, 'preflightCallsMax': 2,
                   'formalRetrievalExecutionsMax': 1, 'explicitRetries': 0, 'perTurnTimeoutSeconds': 120,
                   'ownedLogicalBytesMax': 300_000_000, 'nativeTargetedBuildsMax': 2},
        'validationPlan': {'checks': ['Python syntax/protocol fixture preflight on old material',
                                      'Collect and run only native_sqlite_tantivy_passage_parity opt-in test',
                                      'Freeze new corpus/questions/scorer/source hashes before first retrieval',
                                      'One formal comparison and offline scoring/cost/ownership verification'],
                           'estimatedMinutes': '30-50 including shared cached Rust build; no full project tests/build/package',
                           'remoteFailureEvidence': 'No Git repository/remote in this checkout; not applicable'},
        'stop': 'Deliver comparison and remaining gate gaps; no backend decision, latency tuning, later batches or unattended soak.',
        'supersedesSamplingOnly': {'priorMethod':str(previous/'method-contract.json'),
            'priorFailureSha256':digest(previous/'sampling-failure.json'),
            'stage':'Before any question authoring or validation retrieval. Eligibility counts only; no observed retrieval outcomes.',
            'change':'Use three existing text-rich clusters instead of sparse software/paid-article/fallback folders. All other method/scoring/model/budget requirements retained.'},
    })
    print('Parity scope registered before source selection.')
