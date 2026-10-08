import { create } from 'zustand';
import { useEffect, useRef } from 'react';
import type { Ma2AuditionState } from '@tb/schema';
const initial:Ma2AuditionState={version:1,revision:0,generation:0,phase:'idle',targets:[]};
export const useMa2AuditionStore=create<{state:Ma2AuditionState;error:string}>()(()=>({state:initial,error:''}));
function receive(state:Ma2AuditionState):void{if(state.revision>=useMa2AuditionStore.getState().state.revision)useMa2AuditionStore.setState({state,error:''});}
export function observeMa2Audition():()=>void{
  const unsubscribe=window.tbLink.onMa2AuditionState(receive);let active=true;
  void window.tbLink.controlMa2Audition({version:1,action:'status'}).then(state=>{if(active)receive(state);}).catch((error:unknown)=>{if(active)useMa2AuditionStore.setState({error:String(error)});});
  return()=>{active=false;unsubscribe();};
}
let stopping:Promise<void>|null=null;
export async function acknowledgeClosedMa2Audition(targetId:string):Promise<void>{
  try{receive(await window.tbLink.controlMa2Audition({version:1,action:'acknowledge-closed',targetId}));}
  catch(error){useMa2AuditionStore.setState({error:error instanceof Error?error.message:String(error)});}
}
/** Clear local audition selection at either stop entry, including an idle timeline. */
export function useAuditionSelectionReset(reset:()=>void):void {
  const latest=useRef(reset);
  useEffect(()=>{latest.current=reset;});
  useEffect(()=>useMa2AuditionStore.subscribe((current,previous)=>{
    if(current.state.phase==='stopping'&&previous.state.phase!=='stopping')latest.current();
  }),[]);
}
export function stopMa2Audition():Promise<void>{
  if(stopping)return stopping;
  useMa2AuditionStore.setState(current=>({state:{...current.state,phase:'stopping'},error:''}));
  stopping=window.tbLink.controlMa2Audition({version:1,action:'stop'}).then(receive).catch((error:unknown)=>{useMa2AuditionStore.setState(current=>({state:{...current.state,phase:'failed'},error:error instanceof Error?error.message:String(error)}));throw error;}).finally(()=>{stopping=null;});
  return stopping;
}
