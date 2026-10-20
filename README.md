# Triển khai hệ thống đặt cọc Laguna (project: laguna-acc)

## Đã làm sẵn
- `public/index.html`: đã điền cấu hình Firebase của dự án `laguna-acc`.
- `firebase.json`, `.firebaserc`: trỏ tới dự án `laguna-acc`.
- `functions/.env.laguna-acc`: **cần sửa `GMAIL_USER`** thành Gmail dùng để gửi thư nhắc.

## Các bước (chạy trong thư mục laguna-deploy)

1. Cài công cụ và đăng nhập
   ```
   npm i -g firebase-tools
   firebase login
   ```

2. Trên Firebase Console (https://console.firebase.google.com/project/laguna-acc)
   - Build > Authentication > Sign-in method: bật **Email/Password**, rồi tab Users > **Add user** để tạo tài khoản đăng nhập cho kế toán.
   - Build > Firestore Database: **Create database** (chọn vị trí asia-southeast1 nếu có).
   - Nâng cấp dự án lên gói **Blaze** (bắt buộc để chạy Functions và Scheduler; dùng ít thì gần như miễn phí).

3. Tạo 2 secret
   ```
   firebase functions:secrets:set GMAIL_APP_PASSWORD
   firebase functions:secrets:set ANTHROPIC_API_KEY
   ```
   - `GMAIL_APP_PASSWORD`: mật khẩu ứng dụng 16 ký tự của Gmail (Tài khoản Google > Bảo mật > Xác minh 2 bước > Mật khẩu ứng dụng).
   - `ANTHROPIC_API_KEY`: lấy tại https://console.anthropic.com

4. Cài thư viện cho functions
   ```
   cd functions && npm install && cd ..
   ```

5. Deploy tất cả
   ```
   firebase deploy
   ```
   Sau khi xong, web chạy tại https://laguna-acc.web.app

## Lưu ý
- Thêm file `public/logo.png` nếu muốn hiện logo (không có thì hiện chữ LAGUNA).
- Rules hiện cho mọi tài khoản đã đăng nhập đọc/ghi. Chỉ tạo tài khoản cho người cần dùng.
- `apiKey` trong cấu hình web không phải bí mật; an toàn của dữ liệu nằm ở Authentication và Firestore rules.
