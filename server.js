import express from 'express';
import cors from 'cors';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';

const app = express();

// អនុញ្ញាតឲ្យ Frontend មកពីគ្រប់ទិសទីអាចហៅទៅកាន់ API នេះបាន
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// បង្កើត Folder សម្រាប់ទុកហ្វាយបណ្ដោះអាសន្ន បើមិនទាន់មាន
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

const upload = multer({ dest: 'uploads/' });

// 🔒 ទាញយក Token ពីប្រព័ន្ធសុវត្ថិភាពរបស់ Render (កុំសរសេរកូដសម្ងាត់ចូលទីនេះផ្ទាល់)
const HF_TOKEN = process.env.HF_TOKEN; 

// ==========================================
// 🔄 [GET] សម្រាប់ឆែកមើលស្ថានភាព Server (Health Check)
// ==========================================
app.get('/api/status', (req, res) => {
    res.json({ 
        status: "online", 
        message: "Server ដើររលូនល្អណាស់ bro!",
        timestamp: new Date() 
    });
});

// ==========================================
// 🔄 [POST] សម្រាប់ទទួល Upload និងច្នៃហ្វាយសំឡេង
// ==========================================
app.post('/api/process-file', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "មិនមានឯកសារឡើយ" });

    const inputPath = req.file.path;
    const audioName = req.file.filename + '.wav';
    const audioPath = path.join('uploads', audioName);

    ffmpeg(inputPath)
        .toFormat('wav')
        .audioFrequency(16000)
        .audioChannels(1)
        .on('end', () => {
            fs.unlinkSync(inputPath); // លុបហ្វាយដើមចោល សន្សំទំហំម៉ាស៊ីន
            res.json({ 
                message: "ច្នៃហ្វាយជោគជ័យ", 
                audioName: audioName 
            });
        })
        .on('error', (err) => {
            console.error(err);
            res.status(500).json({ error: "មានបញ្ហាក្នុងការច្នៃឯកសារសំឡេង" });
        })
        .save(audioPath);
});

// ==========================================
// 🔄 [POST + HEADERS] សម្រាប់ផ្ញើទៅ AI Hugging Face
// ==========================================
app.post('/api/transcript', async (req, res) => {
    const { audioName } = req.body;
    if (!audioName) return res.status(400).json({ error: "មិនមានឈ្មោះ File Audio" });

    const audioPath = path.join('uploads', audioName);

    if (!fs.existsSync(audioPath)) {
        return res.status(404).json({ error: "រកមិនឃើញឯកសារសំឡេងនៅលើ Server ឡើយ" });
    }

    try {
        const audioBuffer = fs.readFileSync(audioPath);

        console.log("កំពុងផ្ញើសំណើទៅកាន់ Hugging Face AI...");
        
        // 🚀 ប្ដូរលីងទៅជា distil-large-v3 វិញ (រត់លឿនដូចរន្ទះ មិនងាយជាប់ Timeout)
const hfResponse = await fetch(
    "https://api-inference.huggingface.co/models/distil-whisper/distil-large-v3",
    {
        method: "POST",
        headers: { 
            "Authorization": `Bearer ${HF_TOKEN}`,
            "Content-Type": "audio/wav"
        },
        body: audioBuffer,
    }
);


        const result = await hfResponse.json();

        // ប្រើរួច លុបហ្វាយសំឡេងចេញភ្លាម កុំឲ្យណែនម៉ាស៊ីន Free Tier
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

        if (result.error) {
            return res.status(500).json({ error: "AI Error: " + result.error });
        }

        res.json({ text: result.text || "AI ស្ដាប់ហើយ តែមិនឮនិយាយអ្វីសោះ bro!" });

    } catch (error) {
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        console.error(error);
        res.status(500).json({ error: "ការភ្ជាប់ទៅកាន់ AI មានបញ្ហា៖ " + error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Backend កំពុងរត់លើ Port ${PORT}`);
});
