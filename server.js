const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// --- CẤU HÌNH SERVER ---
const app = express();
app.use(cors()); // Cho phép mọi nguồn kết nối
app.use(bodyParser.json());

const server = http.createServer(app);

// 1. KẾT NỐI DATABASE (POSTGRESQL TRÊN RENDER)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Bắt buộc cho Render
    }
});

const SECRET_KEY = "bi_mat_cua_ban_123"; 

// --- CẤU HÌNH GỬI MAIL (ĐÃ SỬA LỖI TREO IPV6) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    // 👇 QUAN TRỌNG: Thêm dòng này để ép dùng IPv4
    family: 4, 
    
    // 👇 Thêm các timeout này để nếu lỗi thì báo ngay sau 10s, không đợi 2 phút
    connectionTimeout: 10000, 
    greetingTimeout: 5000,
    socketTimeout: 10000
});
// --- PHẦN 1: API HTTP ---

// A. ĐĂNG KÝ
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: "Email đã tồn tại!" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
            'INSERT INTO users (email, password_hash) VALUES ($1, $2)',
            [email, hashedPassword]
        );
        res.json({ success: true, message: "Đăng ký thành công!" });
    } catch (err) {
        console.error("Register Error:", err);
        res.status(500).json({ success: false, message: "Lỗi server." });
    }
});

// B. ĐĂNG NHẬP
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(401).json({ message: "Sai email!" });

        const user = result.rows[0];
        const validPass = await bcrypt.compare(password, user.password_hash);
        if (!validPass) return res.status(401).json({ message: "Sai mật khẩu!" });

        const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY, { expiresIn: '7d' });
        res.json({ success: true, token, email: user.email });
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ message: "Lỗi Server" });
    }
});

// C. QUÊN MẬT KHẨU (GỬI OTP)
app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;

    try {
        // 1. Kiểm tra email
        const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ message: "Email không tồn tại trong hệ thống." });
        }

        // 2. Tạo OTP
        const otp = crypto.randomInt(1000, 9999).toString();

        // 3. Lưu OTP vào DB
        await pool.query('UPDATE users SET reset_token = $1 WHERE email = $2', [otp, email]);

        console.log(`>>> Đang gửi OTP ${otp} tới ${email}...`);

        // 4. Gửi Mail
        const mailOptions = {
            from: '"Smartify Support" <no-reply@smartify.com>',
            to: email,
            subject: 'Mã OTP Smart Home',
            text: `Mã xác nhận của bạn là: ${otp}. Mã này dùng để đặt lại mật khẩu.`
        };

        await transporter.sendMail(mailOptions);
        
        console.log("✅ Gửi mail thành công!");
        res.json({ success: true, message: "Đã gửi mã OTP tới email của bạn!" });

    } catch (e) {
        console.error("❌ LỖI GỬI MAIL/SERVER:", e);
        // Trả về lỗi rõ ràng để App không bị xoay vòng
        res.status(500).json({ 
            success: false, 
            message: "Lỗi khi gửi email (Vui lòng kiểm tra lại Server).",
            error: e.message 
        });
    }
});

// D. XÁC THỰC OTP
app.post('/api/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1 AND reset_token = $2', [email, otp]);
        if (result.rows.length > 0) {
            res.json({ success: true, message: "OTP hợp lệ" });
        } else {
            res.status(400).json({ success: false, message: "OTP không đúng hoặc đã cũ" });
        }
    } catch (e) {
        res.status(500).json({ message: "Lỗi Server" });
    }
});

// E. ĐẶT LẠI MẬT KHẨU MỚI
app.post('/api/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1 AND reset_token = $2', [email, otp]);

        if (result.rows.length === 0) {
            return res.status(400).json({ message: "Phiên làm việc hết hạn!" });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password_hash = $1, reset_token = NULL WHERE email = $2', [hashedPassword, email]);

        res.json({ success: true, message: "Đổi mật khẩu thành công!" });

    } catch (e) {
        console.error(e);
        res.status(500).json({ message: "Lỗi Server" });
    }
});

// --- PHẦN 2: WEBSOCKET SERVER ---
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('🔌 Client WS kết nối');

    ws.on('message', async (message) => {
        try {
            const dataStr = message.toString();
            let data;
            try {
                data = JSON.parse(dataStr);
            } catch (e) { return; }

            if (data.power !== undefined) {
                try {
                    await pool.query(
                        'INSERT INTO power_logs (device_id, power_usage) VALUES ($1, $2)',
                        [data.device_id || 'unknown', data.power]
                    );
                } catch (dbErr) {
                    console.error("❌ Lỗi lưu DB Power Logs:", dbErr.message);
                }
            }

            wss.clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(dataStr);
                }
            });

        } catch (err) {
            console.error('❌ Lỗi xử lý message socket:', err);
        }
    });
});

// Route kiểm tra sức khỏe Server
app.get('/', (req, res) => {
    res.send("✅ Smart Home Backend is RUNNING! (Connect via App)");
});

// KHỞI ĐỘNG SERVER
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
});