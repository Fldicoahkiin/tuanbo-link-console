/** Stop commands pass queued reads/cues, but never interrupt the protocol's in-flight response. */
export class Ma2CommandQueue {
  private active=false;
  private queue:{priority:'normal'|'stop';run:()=>Promise<string>;resolve:(value:string)=>void;reject:(reason:unknown)=>void}[]=[];
  schedule(run:()=>Promise<string>,priority:'normal'|'stop'):Promise<string>{
    return new Promise((resolve,reject)=>{this.queue.push({run,priority,resolve,reject});void this.drain();});
  }
  private async drain():Promise<void>{
    if(this.active)return;this.active=true;
    try{while(this.queue.length){const urgent=this.queue.findIndex(entry=>entry.priority==='stop');const job=this.queue.splice(urgent<0?0:urgent,1)[0]!;try{job.resolve(await job.run());}catch(error){job.reject(error);}}}
    finally{this.active=false;}
  }
}
