const SupportTicket = require('../models/SupportTicket');
const User = require('../models/User');
const { sendMail } = require('../services/emailService');
const { escapeHtml } = require('../utils/identity');

const clean = (v,n) => String(v || '').trim().slice(0,n);
async function createTicket(req,res) {
  const email=clean(req.body.email || req.session.user?.email,254).toLowerCase();
  const subject=clean(req.body.subject,120), message=clean(req.body.message,5000);
  const CATS=['General question','Account access','Card issue','Transfer issue','Complaint','Feedback','Savings','Security concern','Other'];
  const category=CATS.includes(req.body.category)?req.body.category:'General question';
  if(!/^\S+@\S+\.\S+$/.test(email) || subject.length<3 || message.length<10)
    return res.status(400).json({error:'Enter a valid email, subject, and message of at least 10 characters.'});
  const userId=req.session.user?.id || null;
  const ticket=await SupportTicket.create({userId,email,name:clean(req.body.name || req.session.user?.name,80),subject,category,message});
  const ticketId=String(ticket._id);
  const supportEmail=process.env.SUPPORT_EMAIL || process.env.MAIL_FROM;
  const text=`New Harborline support request\nTicket: ${ticketId}\nFrom: ${email}\nCategory: ${category}\nSubject: ${subject}\n\n${message}`;
  (async()=>{try {
    if(supportEmail) await sendMail({to:supportEmail,subject:`[Harborline Support ${ticketId.slice(-8)}] ${subject}`,text,html:`<h2>New support request</h2><p><b>Ticket:</b> ${escapeHtml(ticketId)}</p><p><b>From:</b> ${escapeHtml(email)}</p><p><b>Category:</b> ${escapeHtml(category)}</p><p><b>Subject:</b> ${escapeHtml(subject)}</p><p>${escapeHtml(message).replace(/\n/g,'<br>')}</p>`});
    await sendMail({to:email,subject:`We received your Harborline support request (${ticketId.slice(-8)})`,text:`Hello${req.body.name?' '+clean(req.body.name,80):''},\n\nWe received your message and created ticket ${ticketId}. Our support team will follow up by email.\n\nHarborline Support`,html:`<p>We received your message and created support ticket <b>${escapeHtml(ticketId)}</b>.</p><p>Our support team will follow up by email.</p><p>Harborline Support</p>`});
  } catch(e) { console.error('Support email delivery issue:',e.message); }})();
  res.status(201).json({ticket:{id:ticketId,status:ticket.status,subject:ticket.subject,createdAt:ticket.createdAt},message:'Your message was sent. We will reply here and by email.'});
}
async function listMine(req,res){
 const tickets=await SupportTicket.find({userId:req.session.user.id}).sort({createdAt:-1}).limit(50).select('subject category message status createdAt updatedAt replies').lean();
 res.json({tickets});
}

async function replyMine(req,res){
 const message=clean(req.body.message,5000);
 if(message.length<2)return res.status(400).json({error:'Type your reply first.'});
 const ticket=await SupportTicket.findOne({_id:req.params.id,userId:req.session.user.id});
 if(!ticket)return res.status(404).json({error:'Ticket not found.'});
 ticket.replies.push({author:'customer',message});
 if(ticket.status==='resolved')ticket.status='open';
 await ticket.save();
 res.json({ticket:{id:ticket.id,status:ticket.status,replies:ticket.replies}});
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
 if(ticket.userId){try{await require('../services/notificationService').notify(ticket.userId,'Support replied',`Support replied to "${ticket.subject}". Open Help & support to read it.`)}catch(e){}}
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
 const raw=clean(req.body.message,1000);
 if(raw.length<2)return res.status(400).json({error:'Type a question first.'});
 const m=raw.toLowerCase();
 // Keyword sets include common English, Spanish, French, Portuguese, German and Arabic/Hindi/Chinese terms.
 const topics=[
  ['human',/human|agent|person|support|complain|agente|persona|humain|conseiller|pessoa|mensch|\u0645\u0648\u0638\u0641|\u4eba\u5de5|\u5ba2\u670d|\u0907\u0902\u0938\u093e\u0928/],
  ['balance',/balance|funds|saldo|solde|kontostand|\u0631\u0635\u064a\u062f|\u4f59\u989d|\u092c\u0948\u0932\u0947\u0902\u0938/],
  ['transfer',/transfer|send|sent|payment|not received|enviar|transferencia|virement|envoyer|transferir|\u00fcberweisung|\u062a\u062d\u0648\u064a\u0644|\u8f6c\u8d26|\u0924\u094d\u0930\u093e\u0902\u0938\u092b\u0930/],
  ['card',/card|freeze|lock|tarjeta|carte|cart\u00e3o|karte|\u0628\u0637\u0627\u0642\u0629|\u5361|\u0915\u093e\u0930\u094d\u0921/],
  ['login',/password|login|sign in|otp|code|contrase|mot de passe|senha|passwort|\u0643\u0644\u0645\u0629|\u5bc6\u7801|\u092a\u093e\u0938\u0935\u0930\u094d\u0921/],
  ['savings',/savings|goal|ahorro|\u00e9pargne|poupan|sparen|\u0627\u062f\u062e\u0627\u0631|\u50a8\u84c4|\u092c\u091a\u0924/],
  ['alerts',/email|alert|notification|receipt|recibo|re\u00e7u|recibo|beleg|\u0625\u064a\u0635\u0627\u0644|\u6536\u636e|\u0930\u0938\u0940\u0926/],
  ['language',/language|translate|idioma|langue|sprache|\u0644\u063a\u0629|\u8bed\u8a00|\u092d\u093e\u0937\u093e/]
 ];
 const answers={
  human:'I can connect you with our team. Open Help & support, choose "Send a message", and we will reply there and by email. Please do not share your password or one-time code.',
  balance:'Your balances are on Overview. They update on their own when money arrives or leaves, and you can tap Refresh at any time.',
  transfer:'Open Send money. Type the 10-digit account number and the account holder\'s name appears so you can confirm it before sending. To check a payment, open Transactions and tap the entry for the full details and receipt. If something looks wrong, send us a Transfer issue message from Help & support.',
  card:'Open Cards to see your card and its controls. If a card is lost or compromised, freeze it right away and message support.',
  login:'Use Sign in, then Forgot password to reset access. Never share your password or one-time code with anyone, including support.',
  savings:'Open Savings to create a goal, add money, or review progress.',
  alerts:'Credit and debit alerts are emailed with a PDF receipt. You can turn them on or off in Security, under Email preferences.',
  language:'Use the language selector at the top of the page to read Harborline in your own language.'
 };
 const hit=topics.find(([,rx])=>rx.test(m));
 const key=hit?hit[0]:null;
 res.json({
  reply:key?answers[key]:'I can help with transfers, balances, cards, savings, alerts and sign-in. For anything specific to your account, send a message from Help & support. Please do not share passwords, one-time codes, full card numbers or PINs here.',
  handoff:key==='human'
 });
}
module.exports={createTicket,replyMine,listMine,listAdmin,replyAdmin,updateStatus,chat};
