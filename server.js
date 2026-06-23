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
        // បន្ថែម quantized: true ដើម្បីឲ្យ Model រត់ក្នុងទំហំតូចបំផុត សន្សំសំចៃ RAM
        transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', { quantized: true });
        console.log("Model Loaded!");
    }
    return transcriber;
}
getTranscriber(); 

// មុខងារជំនួយ៖ បម្លែង WAV ទៅជាទិន្នន័យលេខរាយ (Raw PCM Float32)
const convertWavToPcm = (wavPath, pcmPath) => {
    return new Promise((resolve, reject) => {
        ffmpeg(wavPath)
            .toFormat('f32le') 
            .audioFrequency(16000)
            .audioChannels(1)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .save(pcmPath);
    });
};

// 1. API សម្រាប់ Upload 
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

// 2. API សម្រាប់ Transcript (ទម្រង់សន្សំសំចៃ RAM ខ្ពស់)
app.post('/api/transcript', async (req, res) => {
    const { audioName, language } = req.body;
    if (!audioName) return res.status(400).json({ error: "មិនមានឈ្មោះ File Audio" });

    const audioPath = path.join('uploads', audioName);
    const pcmPath = audioPath + '.pcm';

    if (!fs.existsSync(audioPath)) {
        return res.status(404).json({ error: "រកមិនឃើញឯកសារសំឡេង" });
    }

    try {
        await convertWavToPcm(audioPath, pcmPath);

        // វិធីសាស្ត្រថ្មី៖ អានទិន្នន័យផ្ទាល់ពី Memory Buffer ដោយមិនបង្កើតទិន្នន័យស្ទួន (Zero-Copy)
        const buffer = fs.readFileSync(pcmPath);
        const audioData = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);

        const model = await getTranscriber();
        const options = { task: 'transcribe' };
        if (language && language !== 'auto') {
            options.language = language;
        }

        const result = await model(audioData, options);

        // សម្អាតទិន្នន័យក្នុង RAM ភ្លាមៗក្រោយប្រើរួច
        if (fs.existsSync(pcmPath)) fs.unlinkSync(pcmPath);

        res.json({ text: result.text });

    } catch (error) {
        if (fs.existsSync(pcmPath)) fs.unlinkSync(pcmPath);
        console.error(error);
        res.status(500).json({ error: "AI មានបញ្ហាក្នុងការស្ដាប់៖ " + error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
