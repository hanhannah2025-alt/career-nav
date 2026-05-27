require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// DeepSeek API client (OpenAI-compatible)
const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY || 'sk-placeholder',
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
});

const MODEL = 'deepseek-chat';

// Multer setup for file uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// ======== Chat helper ========
async function chat(systemPrompt, userContent, temperature = 0.7) {
  const messages = [
    { role: 'system', content: systemPrompt },
  ];
  if (typeof userContent === 'string') {
    messages.push({ role: 'user', content: userContent });
  } else if (Array.isArray(userContent)) {
    messages.push(...userContent);
  }

  // Remove placeholder
  if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY === 'your_deepseek_api_key_here') {
    return '请在 .env 文件中配置 DEEPSEEK_API_KEY';
  }

  const response = await client.chat.completions.create({
    model: MODEL,
    messages,
    temperature,
    max_tokens: 4096,
  });
  return response.choices[0].message.content;
}

// ======== Prompt templates ========
const RESUME_ANALYZE_PROMPT = `你是一位资深HR和简历优化专家。请严格按以下JSON格式返回分析结果（不要包含markdown代码块标记，只返回纯JSON）：

{
  "score": <0-100的整数，表示简历与岗位的匹配度>,
  "comparison": [
    {"element": "学历", "status": "full", "detail": "你的情况 vs 岗位要求"},
    {"element": "专业", "status": "full", "detail": "你的专业 vs 岗位要求专业"},
    {"element": "经验要求", "status": "partial", "detail": "你的年限 vs 要求年限"},
    {"element": "岗位技能", "status": "full", "detail": "匹配的技能列表"},
    {"element": "项目经历", "status": "full", "detail": "项目匹配情况"}
  ],
  "suggestions": {
    "missing": ["缺失的技能或经验，每个字符串不超过30字"],
    "supplement": ["需要补充量化数据的地方，每个字符串不超过30字"],
    "risks": ["潜在风险点，每个字符串不超过30字"]
  },
  "optimizedResume": "基于JD优化后的简历文本，关键修改处用【】包裹标注"
}

status字段说明：full=完全匹配，partial=勉强及格，missing=缺失`;

const INTERVIEW_PROMPT = `你是一位专业的面试教练。根据用户提供的简历和岗位JD进行模拟面试。

规则：
1. 每次只问一个问题，等待用户回答后再继续
2. 对用户的每个回答给出简短评估（1-2句话，包含优点和改进建议）
3. 追问要由浅入深，逐步深入
4. 覆盖行为面试、技术能力、项目经验三个维度
5. 用中文交流，语气专业但友善
6. 在合适的时候（约3-4轮后）可以问用户是否想换一个话题方向`;

const OFFER_PROMPT = `你是一位资深的职业规划顾问，帮助用户对比分析多个Offer。

规则：
1. 先理解用户的价值取向和职业目标
2. 从多维度做结构化分析：薪资、福利、成长空间、工作地点、行业前景、工作强度等
3. 通过反问引导用户深入思考自己真正看重什么
4. 给出有温度、有深度的建议，不只是冷冰冰的数据对比
5. 提醒用户关注容易被忽视的细节（如五险一金、公积金、试用期、竞业协议等）
6. 用中文交流，语气像一位有经验的朋友`;

// ======== API Routes ========

// 1. File parsing (PDF or image OCR)
app.post('/api/parse-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext);

    let text;
    if (isImage) {
      const Tesseract = require('tesseract.js');
      const { data } = await Tesseract.recognize(filePath, 'chi_sim+eng');
      text = data.text;
    } else {
      const pdfParse = require('pdf-parse');
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      text = data.text;
    }

    // Clean up uploaded file
    fs.unlink(filePath, () => {});

    res.json({
      text: text.trim(),
      type: isImage ? 'image' : 'pdf',
      length: text.trim().length,
    });
  } catch (err) {
    console.error('File parse error:', err);
    res.status(500).json({ error: '文件解析失败：' + err.message });
  }
});

// 2. Resume analysis
app.post('/api/resume/analyze', async (req, res) => {
  try {
    const { resumeText, jdText } = req.body;
    if (!resumeText || !jdText) {
      return res.status(400).json({ error: '请提供简历文本和岗位JD文本' });
    }

    const userContent = `简历：\n${resumeText}\n\n岗位JD：\n${jdText}`;
    const raw = await chat(RESUME_ANALYZE_PROMPT, userContent, 0.3);

    // Parse JSON from response (handle possible markdown wrapping)
    let json = raw;
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) json = match[0];

    const result = JSON.parse(json);
    res.json(result);
  } catch (err) {
    console.error('Resume analyze error:', err);
    res.status(500).json({ error: '分析失败：' + err.message });
  }
});

// 3. Interview chat
app.post('/api/interview/chat', async (req, res) => {
  try {
    const { messages, resumeText, jdText } = req.body;
    if (!messages) return res.status(400).json({ error: '请提供对话历史' });

    const systemPrompt = resumeText
      ? `${INTERVIEW_PROMPT}\n\n用户的简历：\n${resumeText}\n\n目标岗位JD：\n${jdText}`
      : INTERVIEW_PROMPT;

    // Build full message array for API
    const fullMessages = messages.map(m => ({ role: m.role, content: m.content }));

    const reply = await chat(systemPrompt, fullMessages, 0.8);
    res.json({ reply });
  } catch (err) {
    console.error('Interview chat error:', err);
    res.status(500).json({ error: '对话失败：' + err.message });
  }
});

// 4. Offer chat
app.post('/api/offer/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages) return res.status(400).json({ error: '请提供对话历史' });

    const fullMessages = messages.map(m => ({ role: m.role, content: m.content }));
    const reply = await chat(OFFER_PROMPT, fullMessages, 0.8);
    res.json({ reply });
  } catch (err) {
    console.error('Offer chat error:', err);
    res.status(500).json({ error: '对话失败：' + err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: MODEL });
});

app.listen(PORT, () => {
  console.log(`职途导航后端已启动: http://localhost:${PORT}`);
  if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY === 'your_deepseek_api_key_here') {
    console.log('⚠ 请在 .env 文件中配置 DEEPSEEK_API_KEY');
  }
});
