import express from 'express';
import cors from 'cors';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import { pipeline, env } from '@xenova/transformers';
import fs from 'fs';
import path from 'path';

env.cacheDir = './.cache';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

const upload = multer({ dest: 'uploads/' });

let transcriber;
async function getTranscriber() {
    if (!transcriber) {
        console.log("Loading AI Model...");
        transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny');
        console.log("Model Loaded!");
    }
    return transcriber;
}
getTranscriber(); 

// មុខងារជំនួយ៖ បម្លែង WAV ទៅជាទិន្នន័យលេខរាយ (Raw PCM Float32) សម្រាប់ AI
const convertWavToPcm = (wavPath, pcmPath) => {
    return new Promise((resolve, reject) => {
        ffmpeg(wavPath)
            .toFormat('f32le') // បម្លែងទៅជា 32-bit floating point PCM
            .audioFrequency(16000)
            .audioChannels(1)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .save(pcmPath);
    });
};

// 1. API សម្រាប់ Upload និងរៀបចំឯកសារ (ទុកអោយ Frontend ចាក់ស្ដាប់ និងទាញយក)
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
            fs.unlinkSync(inputPath); 
            res.json({ 
                message: "ជោគជ័យ", 
                audioName: audioName,
                audioUrl: `/uploads/${audioName}` 
            });
        })
        .on('error', (err) => {
            console.error(err);
            res.status(500).json({ error: "មានបញ្ហាក្នុងការច្នៃឯកសារសំឡេង" });
        })
        .save(audioPath);
});

// 2. API សម្រាប់ Transcript (កែសម្រួលឲ្យហុច Float32Array ទៅឲ្យ AI)
app.post('/api/transcript', async (req, res) => {
    const { audioName, language } = req.body;
    if (!audioName) return res.status(400).json({ error: "មិនមានឈ្មោះ File Audio" });

    const audioPath = path.join('uploads', audioName);
    const pcmPath = audioPath + '.pcm'; // បង្កើត File បណ្ដោះអាសន្ន

    if (!fs.existsSync(audioPath)) {
        return res.status(404).json({ error: "រកមិនឃើញឯកសារសំឡេង" });
    }

    try {
        // ជំហានទី ១៖ ប្រើ ffmpeg ទាញយកទិន្នន័យលេខរាយពីហ្វាយ WAV
        await convertWavToPcm(audioPath, pcmPath);

        // ជំហានទី ២៖ អានឯកសារលេខរាយនោះ រួចបម្លែងវាទៅជា Float32Array ត្រឹមត្រូវតាមច្បាប់ Node.js
        const buffer = fs.readFileSync(pcmPath);
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
        const audioData = new Float32Array(arrayBuffer);
        
        // ជំហានទី ៣៖ លុបហ្វាយបណ្ដោះអាសន្ន (.pcm) ចោលដើម្បីកុំឲ្យធ្ងន់ម៉ាស៊ីន
        if (fs.existsSync(pcmPath)) fs.unlinkSync(pcmPath);

        // ជំហានទី ៤៖ បញ្ជូនគំនរទិន្នន័យលេខ (audioData) ទៅឲ្យ AI ដំណើរការ
        const model = await getTranscriber();
        const options = { task: 'transcribe' };
        if (language && language !== 'auto') {
            options.language = language;
        }

        const result = await model(audioData, options); // លែងហុចផ្លូវហ្វាយ គឺហុចទិន្នន័យលេខចំៗ
        res.json({ text: result.text });

    } catch (error) {
        if (fs.existsSync(pcmPath)) fs.unlinkSync(pcmPath); // ការពារករណី Error តែមិនទាន់បានលុបហ្វាយ
        console.error(error);
        res.status(500).json({ error: "AI មានបញ្ហាក្នុងការស្ដាប់៖ " + error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
