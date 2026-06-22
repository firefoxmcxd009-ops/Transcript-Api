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

// 1. API រួមសម្រាប់ Upload ទាំង Video និង Audio (បម្លែងទៅជា 16kHz WAV ដូចគ្នា)
app.post('/api/process-file', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "មិនមានឯកសារឡើយ" });

    const inputPath = req.file.path;
    const audioName = req.file.filename + '.wav';
    const audioPath = path.join('uploads', audioName);

    // មិនថាជា Video ឬ Audio ទេ គឺបម្លែងទៅជា WAV 16kHz ទាំងអស់ដើម្បីឲ្យ AI ដំណើរការបានល្អ
    ffmpeg(inputPath)
        .toFormat('wav')
        .audioFrequency(16000)
        .audioChannels(1)
        .on('end', () => {
            fs.unlinkSync(inputPath); // លុបហ្វាយដើមចោល
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

// 2. API សម្រាប់ Transcript
app.post('/api/transcript', async (req, res) => {
    try {
        const { audioName, language } = req.body;
        if (!audioName) return res.status(400).json({ error: "មិនមានឈ្មោះ File Audio" });

        const audioPath = path.join('uploads', audioName);
        if (!fs.existsSync(audioPath)) return res.status(404).json({ error: "រកមិនឃើញឯកសារសំឡេង" });

        const model = await getTranscriber();
        
        const options = { task: 'transcribe' };
        if (language && language !== 'auto') {
            options.language = language;
        }

        const result = await model(audioPath, options);
        res.json({ text: result.text });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
