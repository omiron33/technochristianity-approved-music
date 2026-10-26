import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
test('sync discovers numbered books and finalized songs awaiting audio without inventing download receipts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'numbered-catalog-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  await cp(new URL('../scripts', import.meta.url), join(root,'scripts'), {recursive:true});
  await writeFile(join(root,'api-token'),'test-token');
  const takeId='ba51019e-3064-4b14-bfff-20af8a34874d';
  const work={id:'chapter:1-kings:18',kind:'chapter',book:'1-kings',chapter:18,title:'All Hype, No Heat - 1 Kings 18',lyrics:'Where the fire at?',audioStatus:'approved',approvedTakeId:takeId,takes:[{id:takeId,approved:true,url:`https://suno.com/song/${takeId}`}],sunoFinalization:{status:'verified'},publications:{youtube:{status:'verified',url:'https://www.youtube.com/watch?v=CnUd1KdRJUw'}}};
  const server=createServer((req,res)=>{
    assert.equal(req.method,'GET');assert.equal(req.headers.authorization,'Bearer test-token');
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url==='/api/v1/studio'?{settings:{paused:false},books:[{slug:'1-kings',name:'1 Kings'}],works:[work],jobs:[]}:{available:true,verses:[{number:1,text:'Canonical source unchanged.'}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  await run(process.execPath,[join(root,'scripts/sync-approved-music.mjs'),'--write-only'],{env:{...process.env,STUDIO_DATA_DIR:root,STUDIO_ORIGIN:`http://127.0.0.1:${server.address().port}`}});
  const catalog=JSON.parse(await readFile(join(root,'approved-chapters.json'),'utf8'));
  assert.equal(catalog.songs.length,1);
  const song=catalog.songs[0];assert.equal(song.id,'1-kings-18');assert.equal(song.book,'1 Kings');assert.equal(song.shortTitle,'All Hype, No Heat');assert.equal(song.audio,null);assert.equal(song.audioSource,'suno');assert.equal(song.youtube,work.publications.youtube.url);assert.equal(song.lyric.text,work.lyrics);assert.equal(song.source.verses[0].text,'Canonical source unchanged.');assert.equal(work.audioDownloadQueue,undefined);
});
