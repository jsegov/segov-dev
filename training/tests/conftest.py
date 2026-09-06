"""Portable synthetic-only exporter fixture, constructed offline by the real JS builder."""
import json
from pathlib import Path
import subprocess
import pytest


@pytest.fixture
def verified_export(tmp_path):
    exporter = Path(__file__).resolve().parents[1] / "export" / "export-traces.mjs"
    script = """
import {writeSnapshot,buildDataset,digest} from EXPORTER
import fs from 'node:fs'
const dir = process.argv[1]
const rows = Array.from({length:20},(_,i)=>({id:String(i),conversation_id:`synth-${i}`,turn:1,system_prompt_version:i%2?'v1':'v2',model:'teacher',response_model:'teacher-v1',finish_reason:'stop',input_messages:[{role:'user',content:`Synthetic question ${i}`}],response_messages:[{role:'assistant',content:`Synthetic reply ${i}`}],created_at:'2026-01-01'}))
const prompt = v=>({version:v,instructions:'You are a synthetic assistant.',tool_declarations:[],call_settings:{}})
writeSnapshot(rows,{v1:prompt('v1'),v2:prompt('v2')},dir+'/snapshot')
const reviews=JSON.parse(fs.readFileSync(dir+'/snapshot/review-manifest.template.json'))
for(const [id,r] of Object.entries(reviews.rows)) Object.assign(r,{decision:'approved',family_id:'family-'+id,reason:'Reviewed complete synthetic row.'})
const fingerprints={schema_version:1,dataset_sha256:'eval',selection_dataset_sha256:'selection-suite',final_dataset_sha256:'final-suite',question_sha256:[],family_ids:[]}
const policy={schema_version:1,corpus_class:'synthetic',allowed_models:['teacher'],allowed_response_models:['teacher-v1'],allowed_prompt_versions:['v1','v2'],conversation_prefixes:['synth-'],evaluation_fingerprints_sha256:digest(fingerprints)}
for(const [name,data] of Object.entries({reviews,policy,fingerprints}))fs.writeFileSync(dir+'/'+name+'.json',JSON.stringify(data))
buildDataset({snapshotDir:dir+'/snapshot',reviewsPath:dir+'/reviews.json',policyPath:dir+'/policy.json',fingerprintsPath:dir+'/fingerprints.json',outDir:dir+'/dataset'})
""".replace(
        "EXPORTER", json.dumps(exporter.as_uri())
    )
    subprocess.run(
        ["node", "--input-type=module", "-e", script, str(tmp_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return tmp_path / "dataset"
