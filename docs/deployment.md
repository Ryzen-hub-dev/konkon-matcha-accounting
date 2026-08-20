# Matcha Accounting Deployment Guide

## 目标环境
- 站点： https://valaxscrub.rf.gd
- 部署路径：网站根目录下 `api/`

## 1. 上传文件
1. 上传整个 `api/` 目录到 `public_html/`。
2. 确保 `api/.htaccess` 可读且生效。
3. 确保 `logs/` 和 `uploads/` 可写。

## 2. 配置
1. 编辑 `api/config.php`：数据库账号、JWT 密钥、域名白名单。
2. 将 `jwt_secret` 替换为随机长密钥。
3. 将数据库参数替换为 InfinityFree 实际参数。

## 3. 验证
1. 打开 `https://valaxscrub.rf.gd/api/login.php`
2. 发送 POST: {"username":"admin","password":"password"}
3. 检查返回 JSON 的 `success`、`accessToken`。

## 4. 安全
- 不要提交明文密码到 Git。
- 定期更新 `api/config.php` 中密钥。
- 确认 HTTPS 已开启。
