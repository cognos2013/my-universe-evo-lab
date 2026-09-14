interface SavedWorld {id:string;content:string;savedAt:number}
export class LocalWorldStore {
  #factory:IDBFactory;
  constructor(factory:IDBFactory=indexedDB){this.#factory=factory;}
  #open():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{
    const request=this.#factory.open('my-universe',1);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('worlds'))db.createObjectStore('worlds',{keyPath:'id'});};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error??new Error('无法打开存储'));
    request.onblocked=()=>reject(new Error('存储升级被其他窗口阻止'));
  });}
  async save(id:string,content:string):Promise<void>{
    const db=await this.#open();
    try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('worlds','readwrite');tx.objectStore('worlds').put({id,content,savedAt:Date.now()});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error??new Error('保存失败'));tx.onabort=()=>reject(tx.error??new Error('保存事务取消'));});}finally{db.close();}
  }
  async latest():Promise<SavedWorld|null>{
    const db=await this.#open();
    try{return await new Promise((resolve,reject)=>{const tx=db.transaction('worlds','readonly'),req=tx.objectStore('worlds').getAll();req.onsuccess=()=>resolve((req.result as SavedWorld[]).sort((a,b)=>b.savedAt-a.savedAt)[0]??null);req.onerror=()=>reject(req.error);});}finally{db.close();}
  }
}
