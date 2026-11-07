"""No model calls: isolate OTel exporter startup interference with same app-server."""
from latency_support import WORK, save
from latency_transport import Wire

if __name__=='__main__':
    rows=[]
    for enabled in [False,True]:
        wire=None
        try:
            wire=Wire(WORK/('startup-control-'+str(enabled).lower()),'app',telemetry_enabled=enabled)
            rows.append({'otelExporter':enabled,'initializeMs':wire.initialize_ms})
            print(rows[-1],flush=True)
        finally:
            if wire:
                wire.close()
    save('startup-control.json',{'callsToModel':0,'rows':rows,
        'interpretation':'Same settings except diagnostic OTel export; one paired startup observation, no general cold-start distribution or internal TLS root-cause claim.'})
