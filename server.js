const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors'); 
const nodemailer = require('nodemailer'); // Thư viện gửi mail
const path = require('path');
const crypto = require('crypto'); // Tạo OTP ngẫu nhiên

// --- CẤU HÌNH ---
const app = express();
app.use(cors()); // Cho phép mọi nguồn kết nối (CORS)
app.use(bodyParser.json());

// Cấu hình phục vụ Flutter Web (nếu bạn gộp chung vào đây)
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app); 

// 1. KẾT NỐI DATABASE (SỬA ĐỔI CHO RENDER)
const pool = new Pool({
    // Render sẽ tự động cung cấp link này qua biến môi trường
    connectionString: process.env.DATABASE_URL, 
    ssl: {
        rejectUnauthorized: false // Bắt buộc phải có dòng này khi chạy trên Render
    }
});

const SECRET_KEY = "bi_mat_cua_ban_123"; 

// --- CẤU HÌNH GỬI MAIL (SỬA LẠI ĐOẠN NÀY) ---
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",  // Khai báo rõ Host của Google
    port: 465,               // BẮT BUỘC dùng cổng 465 (SSL) để không bị chặn
    secure: true,            // Bật chế độ bảo mật
    auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS
    },
    // Thêm dòng này để tránh lỗi chứng chỉ (nếu có)
    tls: {
        rejectUnauthorized: false 
    }
});

// --- PHẦN 1: API HTTP (CHO APP FLUTTER) ---

// A. ĐĂNG KÝ
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
            'INSERT INTO users (email, password_hash) VALUES ($1, $2)',
            [email, hashedPassword]
        );
        res.json({ success: true, message: "Đăng ký thành công!" });
    } catch (err) {
        console.error(err);
        res.status(400).json({ success: false, message: "Email đã tồn tại hoặc lỗi server." });
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

        const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY, { expiresIn: '1h' });
        res.json({ success: true, token, email: user.email });
    } catch (err) {
        res.status(500).json({ message: "Lỗi Server" });
    }
});

// C. QUÊN MẬT KHẨU (GỬI OTP QUA EMAIL)
app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    
    try {
        // 1. Kiểm tra email có tồn tại trong DB không
        const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ message: "Email không tồn tại trong hệ thống." });
        }

        // 2. Tạo mã OTP 4 số ngẫu nhiên
        const otp = crypto.randomInt(1000, 9999).toString();
        
        // 3. Lưu OTP vào Database (Cập nhật cột reset_token)
        await pool.query('UPDATE users SET reset_token = $1 WHERE email = $2', [otp, email]);
        
        console.log(`>>> Gửi OTP ${otp} tới ${email} <<<`);

        // 4. Gửi Email thật
        const mailOptions = {
            from: '"Smartify Support" <no-reply@smartify.com>',
            to: email,
            subject: 'Mã xác nhận OTP của bạn - Smartify',
            text: `Mã xác nhận của bạn là: ${otp}. Mã này có hiệu lực để đặt lại mật khẩu.`
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error("Lỗi gửi mail:", error);
                return res.status(500).json({ message: "Lỗi khi gửi email. Vui lòng thử lại." });
            }
            res.json({ success: true, message: "Đã gửi mã OTP tới email của bạn!" });
        });

    } catch (e) {
        console.error("Lỗi server:", e);
        res.status(500).json({ message: "Lỗi Server" });
    }
});

// D. XÁC THỰC OTP VÀ ĐẶT LẠI MẬT KHẨU (Gộp chung để đơn giản)
// Trong thực tế có thể tách làm 2 API: Verify OTP riêng và Reset Password riêng
app.post('/api/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body; // otp ở đây là 'code' từ client gửi lên
    
    try {
        // 1. Tìm user có email và OTP khớp
        const result = await pool.query('SELECT * FROM users WHERE email = $1 AND reset_token = $2', [email, otp]);
        
        if (result.rows.length === 0) {
            return res.status(400).json({ message: "Mã OTP không đúng hoặc đã hết hạn!" });
        }

        // 2. Mã hóa mật khẩu mới
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        // 3. Cập nhật mật khẩu và XÓA OTP (để không dùng lại được)
        await pool.query('UPDATE users SET password_hash = $1, reset_token = NULL WHERE email = $2', [hashedPassword, email]);

        res.json({ success: true, message: "Đổi mật khẩu thành công! Hãy đăng nhập lại." });

    } catch (e) {
        console.error(e);
        res.status(500).json({ message: "Lỗi Server khi đặt lại mật khẩu" });
    }
});

// API xác thực OTP riêng (Dùng cho màn hình nhập 4 số)
app.post('/api/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1 AND reset_token = $2', [email, otp]);
        if (result.rows.length > 0) {
            res.json({ success: true, message: "OTP hợp lệ" });
        } else {
            res.status(400).json({ success: false, message: "OTP không đúng" });
        }
    } catch (e) {
        res.status(500).json({ message: "Lỗi Server" });
    }
});


// --- PHẦN 2: WEBSOCKET SERVER (XỬ LÝ ESP32 + LƯU DATABASE) ---
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('🔌 Client WS kết nối');

    ws.on('message', async (message) => {
        try {
            const dataStr = message.toString();
            
            // 1. Cố gắng đọc JSON từ ESP32
            let data;
            try {
                data = JSON.parse(dataStr);
            } catch (e) {
                return; 
            }

            // 2. Nếu là dữ liệu công suất -> LƯU VÀO DB
            if (data.power !== undefined) {
                console.log(`📥 Nhận từ ESP32: Power=${data.power}W`); // Có thể bỏ comment để debug
                try {
                    await pool.query(
                        'INSERT INTO power_logs (device_id, power_usage) VALUES ($1, $2)',
                        [data.device_id || 'unknown', data.power]
                    );
                } catch (dbErr) {
                    console.error("❌ Lỗi lưu DB:", dbErr.message);
                }
            }

            // 3. Gửi lại cho App Flutter (Để hiển thị Realtime)
            wss.clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(dataStr);
                }
            });

        } catch (err) {
            console.error('❌ Lỗi xử lý message:', err);
        }
    });
});

// Xử lý fallback cho Web App
app.get(/(.*)/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- KHỞI ĐỘNG SERVER ---
// Thay vì viết cứng port 8080, hãy sửa thành như sau:
const PORT = process.env.PORT || 8080; // Nếu cloud cấp cổng thì lấy, không thì dùng 8080

server.listen(PORT, () => {
    console.log(`Server đang chạy trên cổng ${PORT}`);
});