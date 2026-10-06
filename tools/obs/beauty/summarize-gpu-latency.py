"""Summarize recorded per-frame GPU latency without changing acceptance gates."""
import argparse
import json
from pathlib import Path
import numpy as np


def totals(records, field, metric):
    return [sum(item[metric] for item in record[field]) for record in records]


def stats(values):
    if not values:
        return None
    if not all(np.isfinite(value) and value >= 0 for value in values):
        raise ValueError('Invalid timing data')
    return {'median':float(np.median(values)), 'p95':float(np.percentile(values,95)), 'maximum':float(max(values))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report',type=Path)
    args = parser.parse_args()
    trace = json.loads(args.report.read_text(encoding='utf-8'))
    faces, bodies = trace['samples'], trace['body_samples']
    result = {'scope':__doc__, 'source':str(args.report), 'units':'milliseconds',
        'faceFrames':len(faces),'bodyFrames':len(bodies),'groups':{}}
    for group,records,field in [('proposals',faces,'proposal_gpu'),('semantic',faces,'semantic_gpu'),('instances',bodies,'instance_gpu')]:
        result['groups'][group] = {metric:stats(totals(records,field,metric)) for metric in ('waitMs','executionMs')}
        result['groups'][group]['submissions'] = sum(len(record[field]) for record in records)
    result['instanceOtherMs'] = stats([max(0,record['instance_ms']-sum(item['waitMs']+item['executionMs'] for item in record['instance_gpu'])) for record in bodies])
    result['slowestFaces'] = sorted(faces,key=lambda record:record['inference_ms'],reverse=True)[:8]
    result['slowestBodies'] = sorted(bodies,key=lambda record:record['processing_ms'],reverse=True)[:8]
    # Early frames remain part of every aggregate and acceptance calculation.
    result['firstFaceFrames'] = faces[:8]
    result['firstBodyFrames'] = bodies[:8]
    output = args.report.with_name(args.report.stem+'-gpu-latency.json')
    output.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({key:value for key,value in result.items() if key not in ('slowestFaces','slowestBodies','firstFaceFrames','firstBodyFrames')}))


if __name__ == '__main__':
    main()
