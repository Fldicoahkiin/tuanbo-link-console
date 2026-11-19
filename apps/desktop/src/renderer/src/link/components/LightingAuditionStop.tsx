import { useEffect } from 'react';
import { LoaderCircle, Square } from 'lucide-react';
import { acknowledgeClosedMa2Audition, observeMa2Audition, stopMa2Audition, useMa2AuditionStore } from '../stores/ma2-audition-store';
export function LightingAuditionStop():JSX.Element{
  const {state,error}=useMa2AuditionStore();useEffect(observeMa2Audition,[]);
  const failed=state.targets.filter(target=>target.state==='failed');
  return <div className="lighting-audition-control"><button className="lighting-stop-audition" data-phase={state.phase} title={state.phase==='stopping'?'正在停止控台 Cue':'停止整台控台上正在运行的 Cue'} aria-label="停止全部控台 Cue" aria-busy={state.phase==='stopping'} disabled={state.phase==='stopping'} onClick={()=>{void stopMa2Audition('stop-console').catch((cause:unknown)=>console.error('停止试听失败',cause));}}>{state.phase==='stopping'?<LoaderCircle size={16}/>:<Square size={16} fill="currentColor"/>}</button>
    {state.phase==='failed'?<details><summary>{failed.length>0&&failed.every(target=>target.connectionChanged)?'原来的控台连接需要确认':'停止未完成'} · {failed.length||1} 项</summary><div role="alert">{error}{failed.map(target=><div key={target.id}><p>{target.network.host} · {target.action.target==='sequence'?`序列 ${target.action.sequence}`:`执行器 ${target.action.executor}`}：{target.error}</p>{target.connectionChanged?<button onClick={()=>{void acknowledgeClosedMa2Audition(target.id);}}>确认原控台</button>:null}</div>)}</div></details>:null}
  </div>;
}
