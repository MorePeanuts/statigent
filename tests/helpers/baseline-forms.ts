export const forms = [
  "regression",
  "binary-label",
  "binary-probability",
  "multiclass-label",
  "multiclass-probability",
  "ordinal",
  "top3",
  "multilabel",
] as const;
export type BaselineForm = (typeof forms)[number];
export function preparationCode(form: BaselineForm) {
  return `from pathlib import Path
import sys
from test_modeling_dataset_v3 import prepare
form=${JSON.stringify(form)}
kind,metric={"regression":("regression","rmse-v1"),"binary-label":("binary","accuracy-v1"),"binary-probability":("binary","roc-auc-v1"),"multiclass-label":("multiclass","micro-f1-v1"),"multiclass-probability":("multiclass","log-loss-sklearn-v1"),"ordinal":("ordinal","quadratic-kappa-ds10-v1"),"top3":("multiclass","top3-hit-ds-v1"),"multilabel":("multilabel","mean-target-auc-v1")}[form]
names=['y','other'] if kind=='multilabel' else ['y']
n=4 if kind in ('multiclass','ordinal') else 2
targets=[dict(name=name,classes=[str(i) for i in range(n)] if kind=='ordinal' else None,positive_class='1' if kind in ('binary','multilabel') else None,levels=[0,2,5,9] if kind=='ordinal' else None) for name in names]
prepare(Path(sys.argv[1]),kind=kind,metric_id=metric,targets=targets,
 train=[(f'train:{i}',i,dict(signal=i,token='a',**{name: i/3 if kind=='regression' else str(i%n) for name in names})) for i in range(40)],
 prediction=[('test:0',0,dict(signal=41,token='a')),('test:1',1,dict(signal=42,token='a'))],
 labels=[('test:0',['1']*len(names)),('test:1',['0']*len(names))],
 explicit_split=dict(train=[f'train:{i}' for i in range(32)],validation=[f'train:{i}' for i in range(32,40)]))
`;
}
export const genericPredictionEntry = `import argparse,json,pickle
from pathlib import Path
import numpy as np,pandas as pd
p=argparse.ArgumentParser()
for k in ('features','output','schema'): p.add_argument('--'+k,required=True)
a=p.parse_args(); protocol=json.loads(Path(a.schema).read_text())['protocol']
assert not Path('/input/data/search/train.csv').exists()
x=pd.read_csv(a.features,dtype=str,keep_default_na=False)
models=pickle.loads(Path('models.pkl').read_bytes()); result={protocol['id_column']: x[protocol['id_column']]}
for model,target,spec in zip(models,protocol['targets'],protocol['prediction']['targets'],strict=True):
 if not target['classes']: result[spec['value_column']]=model.predict(x[protocol['feature_columns']]);continue
 proba=model.predict_proba(x[protocol['feature_columns']]); proba=proba[:,[list(model.classes_).index(c) for c in target['classes']]]
 if spec['value_column']: result[spec['value_column']]=[target['classes'][i] for i in np.argmax(proba,axis=1)]
 for i,c in enumerate(spec['probability_columns']): result[c]=proba[:,i]
 if spec['ranked_column']: result[spec['ranked_column']]=[json.dumps([target['classes'][i] for i in row]) for row in np.argsort(-proba,axis=1,kind='stable')[:,:3]]
from statigent_modeling.protocol_v2 import prediction_columns_v2
columns=prediction_columns_v2(protocol)
pd.DataFrame(result)[columns].to_csv(a.output,index=False)
`;
export function genericTrainingCode() {
  return `from pathlib import Path
import json,pickle,pandas as pd
from sklearn.dummy import DummyClassifier,DummyRegressor
assert not Path('/input/data/final-prediction/test.csv').exists()
assert not Path('/input/data/evaluator/labels.csv').exists()
m=json.loads(Path('/input/data/dataset.json').read_text());p=m['protocol'];x=pd.read_csv('/input/data/search/train.csv',dtype=str,keep_default_na=False)
models=[(DummyClassifier(strategy='prior') if t['classes'] else DummyRegressor()).fit(x[p['feature_columns']],x[t['name']] if t['classes'] else pd.to_numeric(x[t['name']])) for t in p['targets']]
b=Path('/tmp/baseline-models/selected');b.mkdir(parents=True)
(b/'models.pkl').write_bytes(pickle.dumps(models))
(b/'predict.py').write_text(${JSON.stringify(genericPredictionEntry)})`;
}
