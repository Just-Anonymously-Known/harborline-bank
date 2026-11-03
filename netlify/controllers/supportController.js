const SupportTicket = require('../models/SupportTicket');
const User = require('../models/User');
const { sendMail } = require('../services/emailService');
const { escapeHtml } = require('../utils/identity');

const clean = (v,n) => String(v || '').trim().slice(0,n);
async function createTicket(req,res) {
  const email=clean(req.body.email || req.session.user?.email,254).toLowerCase();
  const subject=clean(req.body.subject,120), message=clean(req.body.message,5000);
  const category=clean(req.body.category,40) || 'General question';
  if(!/^\S+@\S+\.\S+$/.test(email) || subject.length<3 || message.length<10)
    return res.status(400).json({error:'Enter a valid email, subject, and message of at least 10 characters.'});
  const userId=req.session.user?.id || null;
  const ticket=await SupportTicket.create({userId,email,name:clean(req.body.name || req.session.user?.name,80),subject,category,message});
  const ticketId=String(ticket._id);
  const supportEmail=process.env.SUPPORT_EMAIL || process.env.MAIL_FROM;
  const text=`New Harborline support request\nTicket: ${ticketId}\nFrom: ${email}\nCategory: ${category}\nSubject: ${subject}\n\n${message}`;
  try {
    if(supportEmail) await sendMail({to:supportEmail,subject:`[Harborline Support ${ticketId.slice(-8)}] ${subject}`,text,html:`<h2>New support request</h2><p><b>Ticket:</b> ${escapeHtml(ticketId)}</p><p><b>From:</b> ${escapeHtml(email)}</p><p><b>Category:</b> ${escapeHtml(category)}</p><p><b>Subject:</b> ${escapeHtml(subject)}</p><p>${escapeHtml(message).replace(/\n/g,'<br>')}</p>`});
    await sendMail({to:email,subject:`We received your Harborline support request (${ticketId.slice(-8)})`,text:`Hello${req.body.name?' '+clean(req.body.name,80):''},\n\nWe received your message and created ticket ${ticketId}. Our support team will follow up by email.\n\nHarborline Support`,html:`<p>We received your message and created support ticket <b>${escapeHtml(ticketId)}</b>.</p><p>Our support team will follow up by email.</p><p>Harborline Support</p>`});
  } catch(e) { console.error('Support email delivery issue:',e.message); }
  res.status(201).json({ticket:{id:ticketId,status:ticket.status,subject:ticket.subject,createdAt:ticket.createdAt},message:'Your support request was recorded. Email delivery depends on SMTP configuration.'});
}
async function listMine(req,res){
 const tickets=await SupportTicket.find({userId:req.session.user.id}).sort({createdAt:-1}).limit(50).select('subject category status createdAt updatedAt replies').lean();
 res.json({tickets});
}
async function listAdmin(req,res){
 const tickets=await SupportTicket.find().sort({status:1,createdAt:-1}).limit(100).populate('userId','name email').lean();
 res.json({tickets});
}
async function replyAdmin(req,res){
 const message=clean(req.body.message,5000);
 if(message.length<2)return res.status(400).json({error:'Reply is too short.'});
 const ticket=await SupportTicket.findById(req.params.id);
 if(!ticket)return res.status(404).json({error:'Ticket not found.'});
 ticket.replies.push({author:'support',message});
 ticket.status=req.body.status==='resolved'?'resolved':'in_progress';
 await ticket.save();
 try{await sendMail({to:ticket.email,subject:`Harborline Support replied: ${ticket.subject}`,text:`Support replied to ticket ${ticket._id}:\n\n${message}\n\nReply to this email or contact support.`,html:`<p>Support replied to ticket <b>${escapeHtml(String(ticket._id))}</b>:</p><p>${escapeHtml(message).replace(/\n/g,'<br>')}</p>`});}catch(e){console.error('Support reply email failed:',e.message)}
 res.json({ticket:{id:ticket.id,status:ticket.status}});
}
async function updateStatus(req,res){
 const status=['open','in_progress','resolved'].includes(req.body.status)?req.body.status:null;
 if(!status)return res.status(400).json({error:'Invalid status.'});
 const ticket=await SupportTicket.findByIdAndUpdate(req.params.id,{status},{new:true}).select('status');
 if(!ticket)return res.status(404).json({error:'Ticket not found.'});
 res.json({ticket});
}
async function chat(req,res){
 const message=clean(req.body.message,1000).toLowerCase();
 if(message.length<2)return res.status(400).json({error:'Type a question first.'});
 const answers=[
  [/balance|available funds/,'For your current balance, sign in and open Overview → Your accounts. I can only show private account details after secure sign-in.'],
  [/transfer|payment|not received/,'Open Overview → Recent activity to check the transfer status. If it is missing or delayed, submit a Transfer issue ticket with the approximate date and amount. Never include your password or OTP.'],
  [/card|freeze|lock/,'Open Cards in your dashboard to review your card and available controls. If your card is lost or compromised, freeze it immediately and contact support.'],
  [/password|login|sign in|otp|code/,'Use Sign in → Forgot password to reset access. Never share your password or one-time verification code with anyone, including support.'],
  [/support|human|agent|person/,'You can reach a human by opening Help & Support and submitting a ticket. We will email your ticket reference.'],
  [/savings|goal/,'Open Savings goals in your dashboard to create a goal, contribute, or review progress.'],
  [/email|alert|notification/,'Open Security center → Email preferences to manage transaction credit/debit alerts and optional Harborline emails.']
 ];
 const hit=answers.find(([rx])=>rx.test(message));
 res.json({reply:hit?hit[1]:'I can help with account access, transfers, cards, savings, notifications, and support. For account-specific or complex issues, please submit a Help & Support ticket. Please do not share passwords, OTPs, full card numbers, or PINs here.',handoff: /support|human|agent|person/.test(message)});
}
module.exports={createTicket,listMine,listAdmin,replyAdmin,updateStatus,chat};
