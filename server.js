const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

const API_KEY = 'jyd93ViKoJuHmNrx1uvwAFsk';
const SECRET_KEY = '1bzbUeG8ntrH0YlIS7Os4m0s9zec97iX';

let accessToken = '';
let tokenExpireTime = 0;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/jpg', 'application/pdf'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件类型，请上传 JPG、PNG 或 PDF 文件'));
    }
  }
});

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const getAccessToken = async () => {
  if (accessToken && Date.now() < tokenExpireTime) return accessToken;
  const url = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${API_KEY}&client_secret=${SECRET_KEY}`;
  const response = await fetch(url, { method: 'POST' });
  const data = await response.json();
  if (data.access_token) {
    accessToken = data.access_token;
    tokenExpireTime = Date.now() + (data.expires_in || 2592000) * 1000;
    return accessToken;
  }
  throw new Error('获取 token 失败');
};

const recognizeGeneralText = async (base64Data) => {
  const token = await getAccessToken();
  const url = `https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=${token}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `image=${encodeURIComponent(base64Data)}`
  });
  return await response.json();
};

const recognizeVatInvoice = async (base64Data) => {
  const token = await getAccessToken();
  const url = `https://aip.baidubce.com/rest/2.0/ocr/v1/vat_invoice?access_token=${token}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `image=${encodeURIComponent(base64Data)}`
  });
  return await response.json();
};

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: '服务运行中', version: '2.1' });
});

app.get('/api/token', async (req, res) => {
  try {
    await getAccessToken();
    res.json({ success: true, message: 'Token 获取成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/recognize', upload.single('image'), async (req, res) => {
  console.log('收到识别请求:', req.file?.originalname);
  
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: '请上传文件' });
    }

    const filePath = req.file.path;
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');

    let data = await recognizeVatInvoice(base64Data);
    let usedApi = 'vat_invoice';
    
    if (data.error_code) {
      console.log('增值税发票识别失败:', data.error_msg);
      data = await recognizeGeneralText(base64Data);
      usedApi = 'general_text';
    }

    fs.unlinkSync(filePath);

    if (data.error_code) {
      return res.status(400).json({ 
        success: false, 
        message: `识别失败: ${data.error_msg}`
      });
    }

    const result = data.words_result;
    let amount = 0;
    let invoiceDate = '';
    let projectName = '*其他服务*服务费';

    if (Array.isArray(result)) {
      const text = result.map(item => item.words).join(' ');
      console.log('识别文本:', text);
      
      // 提取金额
      const amountMatches = text.match(/[¥￥]\s*(\d+[.,]?\d*)/g);
      console.log('金额匹配:', amountMatches);
      
      if (amountMatches && amountMatches.length > 0) {
        const lastAmount = amountMatches[amountMatches.length - 1];
        amount = parseFloat(lastAmount.replace(/[¥￥]\s*/g, '').replace(',', '')) || 0;
        console.log('提取金额:', amount);
      }
      
      // 提取日期
      const dateMatch = text.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/);
      if (dateMatch) {
        invoiceDate = `${dateMatch[1]}年${dateMatch[2].padStart(2, '0')}月${dateMatch[3].padStart(2, '0')}日`;
      }
      
      // 提取项目名称
      if (text.includes('住宿') || text.includes('酒店')) projectName = '*住宿服务*住宿费';
      else if (text.includes('餐饮') || text.includes('餐费')) projectName = '*餐饮服务*餐饮服务';
      else if (text.includes('代驾')) projectName = '*生活服务*代驾服务费';
      else if (text.includes('出租') || text.includes('交通')) projectName = '*运输服务*出租汽车客运服务';
      
    } else {
      if (result.amount_in_figures) {
        amount = parseFloat(String(result.amount_in_figures).replace(/[¥￥,]/g, '')) || 0;
      }
      invoiceDate = result.invoice_date || '';
      if (invoiceDate && /^\d{8}$/.test(invoiceDate)) {
        invoiceDate = `${invoiceDate.slice(0,4)}年${invoiceDate.slice(4,6)}月${invoiceDate.slice(6,8)}日`;
      }
      if (result.commodity_name?.length > 0) {
        projectName = result.commodity_name[0].word || result.commodity_name[0];
      }
    }

    console.log('最终结果:', { amount, invoiceDate, projectName });

    res.json({
      success: true,
      data: { amount, invoiceDate: invoiceDate || new Date().toLocaleDateString('zh-CN'), projectName }
    });

  } catch (error) {
    console.error('识别失败:', error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: '识别失败: ' + error.message });
  }
});

app.listen(PORT, () => {
  console.log(`服务运行在端口 ${PORT}`);
});
