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

const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });

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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: '服务运行中' });
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
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: '请上传图片' });
    }

    const token = await getAccessToken();
    const fileBuffer = fs.readFileSync(req.file.path);
    const base64Image = fileBuffer.toString('base64');

    const url = `https://aip.baidubce.com/rest/2.0/ocr/v1/vat_invoice?access_token=${token}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `image=${encodeURIComponent(base64Image)}`
    });

    fs.unlinkSync(req.file.path);
    const data = await response.json();

    if (data.error_code) {
      return res.status(400).json({ success: false, message: data.error_msg });
    }

    const result = data.words_result;
    let amount = 0;
    if (result.amount_in_figures) {
      amount = parseFloat(String(result.amount_in_figures).replace(/[¥￥,]/g, '')) || 0;
    }

    let invoiceDate = result.invoice_date || '';
    if (invoiceDate && /^\d{8}$/.test(invoiceDate)) {
      invoiceDate = `${invoiceDate.slice(0,4)}年${invoiceDate.slice(4,6)}月${invoiceDate.slice(6,8)}日`;
    }

    res.json({
      success: true,
      data: {
        amount,
        invoiceDate: invoiceDate || new Date().toLocaleDateString('zh-CN'),
        projectName: result.commodity_name?.[0]?.word || '*其他服务*服务费',
        invoiceType: result.invoice_type || '未知',
        sellerName: result.seller_name || ''
      }
    });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`服务运行在端口 ${PORT}`);
});
