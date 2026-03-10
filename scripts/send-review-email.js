#!/usr/bin/env node
// Usage: GMAIL_USERNAME=x GMAIL_APP_PASSWORD=x GMAIL_TO_ADDRESS=x node scripts/send-review-email.js <email.html> [subject]
const nodemailer = require('nodemailer');
const fs = require('fs');

const htmlFile = process.argv[2] || 'email.html';
const subject = process.argv[3] || `Polymarket Daily Review — ${new Date().toISOString().slice(0, 10)}`;

if (!fs.existsSync(htmlFile)) {
  console.error(`File not found: ${htmlFile}`);
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USERNAME,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

transporter.sendMail({
  from: process.env.GMAIL_USERNAME,
  to: process.env.GMAIL_TO_ADDRESS,
  subject,
  html: fs.readFileSync(htmlFile, 'utf8'),
}).then(() => {
  console.log('Email sent successfully');
}).catch((err) => {
  console.error('Failed to send email:', err.message);
  process.exit(1);
});
