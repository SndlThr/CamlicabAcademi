// server.js - Gelişmiş Sınav Backend
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const fse = require("fs-extra");
const { execFile } = require("child_process");
const Tesseract = require("tesseract.js");
const path = require("path");
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- Upload klasörü ---
const UPLOAD_DIR = path.join(__dirname, "uploads");
fse.ensureDirSync(UPLOAD_DIR);

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g,'_')}`)
});
const upload = multer({ storage });

// --- JSON dosyaları ---
const SORULAR_FILE = path.join(__dirname, "sorular.json");
const OGR_FILE = path.join(__dirname, "ogrenciler.json");
const SINAVLAR_FILE = path.join(__dirname, "sinavlar.json");

// --- Yardımcı fonksiyonlar ---
function loadJSON(file) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify([], null, 2));
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw || "[]");
  } catch(e) { console.error(`${file} okunamadı`, e); return []; }
}

function saveJSON(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null,2), 'utf8'); return true; }
  catch(e){ console.error(`${file} yazılamadı`, e); return false; }
}

// Başlangıç verileri
let sorular = loadJSON(SORULAR_FILE);
let ogrenciler = loadJSON(OGR_FILE);
let sinavlar = loadJSON(SINAVLAR_FILE);

// --- PDF -> PNG -> OCR ---
function pdfToPngs(pdfPath, outDir){
  return new Promise((resolve, reject)=>{
    fse.ensureDirSync(outDir);
    const base = path.join(outDir,"page");
    execFile('pdftoppm',['-png',pdfPath,base],(err)=>{
      if(err) return reject(err);
      const files = fs.readdirSync(outDir).filter(f=>f.endsWith('.png')).map(f=>path.join(outDir,f));
      files.sort(); resolve(files);
    });
  });
}

async function ocrImageToText(imgPath){
  const worker = Tesseract.createWorker();
  await worker.load();
  await worker.loadLanguage('eng');
  await worker.initialize('eng');
  const {data:{text}} = await worker.recognize(imgPath);
  await worker.terminate();
  return text;
}

// --- Soru ayrıştırma ---
function parseTextToQuestions(text){
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const joined = lines.join('\n');
  const blocks = joined.split(/\n(?=\s*\d+\s*[)\.])/g);
  const questions = [];
  for(let block of blocks){
    const headerMatch = block.match(/^\s*(\d+)\s*[)\.]\s*(.*)$/s);
    if(!headerMatch) continue;
    const id = parseInt(headerMatch[1]);
    let rest = headerMatch[2].trim().replace(/\r/g,'');
    let cevapParts = rest.split(/\n(?=[A-D]\s*[)\.])|(?=[A-D]\s*[)\.])/g);
    if(cevapParts.length===1) cevapParts = rest.split(/(?=[A-D]\s*\.)/g);
    let qtext = cevapParts[0].replace(/^[A-D]\s*[)\.]\s*/,'').trim();
    let answers = cevapParts.slice(1).map(s=>s.replace(/^[A-D]\s*[)\.]\s*/,'').trim()).slice(0,4);
    questions.push({id,soru:qtext,cevaplar:answers,dogruIndex:null,puan:null,resim:null});
  }
  return questions.sort((a,b)=>(a.id||0)-(b.id||0));
}

// --- Routes ---

// PDF yükleme ve parse
app.post('/upload-pdf',upload.single('pdf'), async (req,res)=>{
  try{
    const sinif = req.body.sinif;
    if(!sinif || !req.file) return res.status(400).json({error:'Eksik veri'});
    const pdfPath = req.file.path;
    let parsedText = '';
    try{ const pdfData = await pdfParse(fs.readFileSync(pdfPath)); parsedText = pdfData.text||''; }catch(e){ parsedText=''; }
    let questions=[];
    if(parsedText.length>50) questions = parseTextToQuestions(parsedText);
    else{
      const outDir = path.join(UPLOAD_DIR,`pages-${Date.now()}`);
      const pngs = await pdfToPngs(pdfPath,outDir);
      let allText='';
      for(let img of pngs){ allText += '\n'+await ocrImageToText(img); }
      if(allText.trim().length>0) questions=parseTextToQuestions(allText);
    }
    questions = questions.map((q,i)=>({id:q.id||(i+1),soru:q.soru,cevaplar:q.cevaplar.length?q.cevaplar:['','','',''],dogruIndex:null,puan:null,resim:q.resim||null}));
    res.json({message:'PDF işlendi, admin onayı bekliyor.',sinif,parsedCount:questions.length,questions});
  }catch(e){ console.error(e); res.status(500).json({error:'Sunucu hatası'}); }
});

// Admin: soruları kaydet
app.post('/save-questions',(req,res)=>{
  const {sinif,questions} = req.body;
  if(!sinif||!Array.isArray(questions)) return res.status(400).json({error:'Geçersiz veri'});
  const normalized = questions.map((q,i)=>({id:q.id||(i+1),soru:q.soru,cevaplar:q.cevaplar.slice(0,4).concat(Array(4-q.cevaplar.length).fill('')),dogruIndex:q.dogruIndex||null,puan:q.puan||null,resim:q.resim||null}));
  sorular = sorular.filter(s=>s.sinif!==sinif).concat(normalized.map(q=>({...q,sinif}))); 
  saveJSON(SORULAR_FILE,sorular);
  res.json({message:`${sinif}. sınıf için ${normalized.length} soru kaydedildi.`});
});

// GET sorular
app.get('/sorular/:sinif',(req,res)=>{
  const sinif=req.params.sinif;
  res.json(sorular.filter(s=>s.sinif===sinif));
});

// Öğrenci sınav gönderimi ve puanlama
app.post('/submit-exam',(req,res)=>{
  const {kadi,sinif,cevaplar} = req.body;
  if(!kadi||!sinif||!Array.isArray(cevaplar)) return res.status(400).json({error:'Geçersiz veri'});
  const user = ogrenciler.find(o=>o.kadi===kadi);
  if(!user) return res.status(404).json({error:'Kullanıcı yok'});
  const sinifSorular = sorular.filter(s=>s.sinif===sinif);
  let toplam = 0;
  for(let c of cevaplar){
    const s = sinifSorular.find(x=>x.id===c.id);
    if(s && s.dogruIndex===c.secilenIndex) toplam+=s.puan||0;
  }
  sinavlar.push({kadi,sinif,tarih:new Date().toISOString(),cevaplar,toplam});
  saveJSON(SINAVLAR_FILE,sinavlar);
  res.json({toplam});
});

// Admin: sınav geçmişi
app.get('/exam-history/:sinif',(req,res)=>{
  const sinif=req.params.sinif;
  const data = sinavlar.filter(s=>s.sinif===sinif);
  res.json(data);
});

// --- Kayıt & Login ---
app.post('/register',(req,res)=>{
  const {kadi,sifre,sinif,role} = req.body;
  if(!kadi||!sifre||!sinif) return res.status(400).json({error:'Eksik alan'});
  if(ogrenciler.some(o=>o.kadi.toLowerCase()===kadi.toLowerCase())) return res.status(400).json({error:'Kullanıcı mevcut'});
  ogrenciler.push({kadi,sifre,sinif,role:role||'ogrenci',puan:0});
  saveJSON(OGR_FILE,ogrenciler);
  res.json({message:'Kayıt başarılı'});
});

app.post('/login',(req,res)=>{
  const {kadi,sifre}=req.body;
  const u = ogrenciler.find(x=>x.kadi.toLowerCase()===(kadi||'').toLowerCase() && x.sifre===sifre);
  if(!u) return res.status(401).json({error:'Hatalı'});
  const {sifre:_,...payload} = u;
  res.json(payload);
});

app.get('/',(req,res)=>res.send('Backend hazır'));

app.listen(port,()=>console.log(`Server ${port} portunda çalışıyor`));
