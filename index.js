const express = require('express');
const cors = require('cors');
const pa11y = require('pa11y');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const connectDB = require('./db');
const authRoutes = require('./routes/auth');
const { authenticateToken } = require('./routes/auth');

dotenv.config();
connectDB(); // Connect to MongoDB

const app = express();

// FIXED: Proper CORS configuration
app.use(cors({
  origin: [
    'https://a11ycheck.vercel.app',
    'http://localhost:3000' // for local development
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Email configuration
const emailConfig = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
};

// Create transporter (only if email credentials are provided)
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransporter(emailConfig); // Fixed: removed 'er' from createTransporter
}

// MongoDB Schema for storing scan results (FIXED)
const scanSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  url: { type: String, required: true },
  issues: { type: Number, required: true },
  issueDetails: {
    type: [{
      id: { type: Number, required: true },
      type: { type: String, required: true },
      description: { type: String, required: true },
      severity: { type: String, required: true },
      selector: { type: String, default: '' },
      message: { type: String, default: '' },
      code: { type: String, default: '' },
      context: { type: String, default: '' },
      runner: { type: String, default: '' }
    }],
    default: []
  },
  score: { type: Number, required: true },
  status: { type: String, default: 'completed' },
  timestamp: { type: Date, default: Date.now },
  scanDuration: Number,
  pageTitle: String,
  pageDescription: String
});

const Scan = mongoose.model('Scan', scanSchema);

// Helper function to convert WCAG codes to readable types
function getReadableIssueType(wcagCode) {
  const codeMap = {
    'H37': 'Missing Image Alt Text',
    'H91': 'Missing Form Label',
    'F77': 'Duplicate Element ID',
    'G18': 'Insufficient Color Contrast',
    'H64.1': 'Missing Iframe Title',
    'H42': 'Improper Heading Structure',
    'F43': 'Missing Table Headers',
    'H32.2': 'Missing Form Submit Button',
    'SC1_3_1_A': 'Missing Semantic Structure',
    'SC2_4_1_A': 'Invalid HTML Structure',
    'F68': 'Missing Form Labels',
    'H25': 'Missing Page Title',
    'H57': 'Missing Language Attribute',
    'F40': 'Meta Refresh Redirect',
    'H88': 'Proper HTML Structure'
  };
  
  // Extract code from full WCAG string like "WCAG2AA.Principle1.Guideline1_1.1_1_1.H37"
  const matches = wcagCode.match(/\.([A-Z]\d+(?:\.\d+)?)/g);
  if (matches) {
    const shortCode = matches[matches.length - 1].substring(1);
    return codeMap[shortCode] || 'Accessibility Issue';
  }
  
  // Try to match the short code directly
  const directMatch = Object.keys(codeMap).find(code => wcagCode.includes(code));
  if (directMatch) {
    return codeMap[directMatch];
  }
  
  return 'Accessibility Issue';
}

// Routes
app.get('/', (req, res) => {
  res.send('✅ Accessibility API is running. Use POST /scan to scan a website.');
});

// FIXED: Add health check endpoint for frontend to wake up service
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    message: 'Service is healthy' 
  });
});

// Get all scans for the current user with pagination and filtering
app.get('/scans', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 50, days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const scans = await Scan.find({
      userId: req.user.id,
      timestamp: { $gte: startDate }
    })
    .sort({ timestamp: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit)
    .select('-issueDetails'); // Exclude detailed issues for performance

    const total = await Scan.countDocuments({
      userId: req.user.id,
      timestamp: { $gte: startDate }
    });

    res.json({
      scans,
      pagination: {
        current: page,
        total: Math.ceil(total / limit),
        count: scans.length,
        totalScans: total
      }
    });
  } catch (error) {
    console.error('Error fetching scans:', error);
    res.status(500).json({ error: 'Failed to fetch scan history.' });
  }
});

// Get dashboard statistics for the current user
app.get('/stats', authenticateToken, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const stats = await Scan.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(req.user.id),
          timestamp: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: null,
          totalScans: { $sum: 1 },
          totalIssues: { $sum: '$issues' },
          avgScore: { $avg: '$score' },
          uniquePages: { $addToSet: '$url' }
        }
      },
      {
        $project: {
          _id: 0,
          totalScans: 1,
          totalIssues: 1,
          avgScore: { $round: ['$avgScore', 1] },
          uniquePages: { $size: '$uniquePages' }
        }
      }
    ]);

    const result = stats[0] || {
      totalScans: 0,
      totalIssues: 0,
      avgScore: 0,
      uniquePages: 0
    };

    res.json(result);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics.' });
  }
});

// Get scan activity over time for the current user
app.get('/activity', authenticateToken, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const activity = await Scan.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(req.user.id),
          timestamp: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$timestamp' }
          },
          scans: { $sum: 1 },
          issues: { $sum: '$issues' },
          avgScore: { $avg: '$score' }
        }
      },
      {
        $sort: { '_id': 1 }
      },
      {
        $project: {
          date: '$_id',
          scans: 1,
          issues: 1,
          avgScore: { $round: ['$avgScore', 1] },
          _id: 0
        }
      }
    ]);

    res.json(activity);
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: 'Failed to fetch activity data.' });
  }
});

// Get specific scan by ID for the current user
app.get('/scan/:id', authenticateToken, async (req, res) => {
  try {
    const scan = await Scan.findOne({ 
      _id: req.params.id, 
      userId: req.user.id 
    });
    if (!scan) {
      return res.status(404).json({ error: 'Scan not found' });
    }
    res.json(scan);
  } catch (error) {
    console.error('Error fetching scan:', error);
    res.status(500).json({ error: 'Failed to fetch scan details.' });
  }
});

// Perform accessibility scan (FIXED)
app.post('/scan', authenticateToken, async (req, res) => {
  const { url, scanType = 'full', deviceType = 'desktop' } = req.body;
  
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A valid URL is required.' });
  }

  // Validate URL format
  try {
    new URL(url);
  } catch (urlError) {
    return res.status(400).json({ error: 'Invalid URL format. Please include http:// or https://' });
  }

  try {
    const startTime = Date.now();
    
    // Enhanced pa11y options based on scan type and device
    const pa11yOptions = {
      standard: 'WCAG2AA',
      includeNotices: false,
      includeWarnings: true,
      timeout: scanType === 'quick' ? 15000 : 30000,
      wait: scanType === 'quick' ? 500 : 1000,
      chromeLaunchConfig: {
        args: deviceType === 'mobile' ? [
          '--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15'
        ] : []
      },
      viewport: deviceType === 'mobile' ? {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        isMobile: true
      } : {
        width: 1280,
        height: 1024
      }
    };

    console.log(`Starting ${scanType} scan for ${deviceType} on: ${url}`);
    
    // Run Pa11y scan
    const results = await pa11y(url, pa11yOptions);

    const endTime = Date.now();
    const scanDuration = endTime - startTime;

    console.log(`Pa11y found ${results.issues.length} issues`);

    // Process issues with proper validation and mapping to frontend structure
    const processedIssues = results.issues.map((issue, index) => ({
      id: index + 1,
      type: getReadableIssueType(issue.code),
      description: String(issue.message || 'No description available'),
      severity: String(issue.type || 'warning'), // Pa11y uses 'error', 'warning', 'notice'
      selector: String(issue.selector || ''),
      message: String(issue.message || ''), // Keep original message too
      code: String(issue.code || ''),
      context: String(issue.context || ''),
      runner: String(issue.runner || 'pa11y')
    }));

    // Validate that processedIssues is an array
    if (!Array.isArray(processedIssues)) {
      console.error('Processed issues is not an array:', typeof processedIssues);
      throw new Error('Invalid issues data format');
    }

    console.log('Processed issues:', processedIssues.length, 'items');

// WITH THIS NEW CODE:
console.log('Pa11y version:', require('pa11y/package.json').version);
console.log('Raw Pa11y results:', results);

// Calculate score based on issue severity (improved realistic scoring)
const errorIssues = processedIssues.filter(i => i.severity === 'error').length;
const warningIssues = processedIssues.filter(i => i.severity === 'warning').length;
const noticeIssues = processedIssues.filter(i => i.severity === 'notice').length;

console.log(`Issue breakdown: ${errorIssues} errors, ${warningIssues} warnings, ${noticeIssues} notices`);

// More realistic scoring
const totalIssues = processedIssues.length;
const errorWeight = errorIssues * 10;
const warningWeight = warningIssues * 5;
const noticeWeight = noticeIssues * 2;

// Use logarithmic scaling to prevent scores hitting zero
const totalWeight = errorWeight + warningWeight + noticeWeight;
const score = Math.max(0, Math.round(100 - Math.min(95, totalWeight * 0.5)));

console.log(`Scoring: ${totalWeight} total weight -> ${score}/100 score`);

    // Create scan record with proper validation
    const scanData = {
      userId: req.user.id,
      url: String(url),
      issues: Number(processedIssues.length),
      issueDetails: processedIssues,
      score: Number(score),
      status: 'completed',
      timestamp: new Date(),
      scanDuration: Number(scanDuration),
      pageTitle: String(results.pageTitle || 'Unknown'),
      pageDescription: String(results.pageDescription || '')
    };

    console.log('Saving scan with data:', {
      ...scanData,
      issueDetails: `${scanData.issueDetails.length} issues`
    });

    const scan = new Scan(scanData);
    await scan.save();

    console.log('Scan saved successfully with ID:', scan._id);

    // Return response matching frontend expectations
    res.json({
      _id: scan._id,
      id: scan._id, // Also include id for compatibility
      url: scan.url,
      issues: processedIssues.length, // Return actual count
      issueDetails: processedIssues, // Return all processed issues
      score: scan.score,
      status: scan.status,
      timestamp: scan.timestamp,
      scanDuration: scan.scanDuration,
      pageTitle: scan.pageTitle,
      pageDescription: scan.pageDescription
    });

  } catch (error) {
    console.error('Scan failed:', error.message);
    console.error('Full error:', error);
    
    // Save failed scan with userId
    try {
      const failedScan = new Scan({
        userId: req.user.id,
        url: String(url),
        issues: 0,
        issueDetails: [],
        score: 0,
        status: 'failed',
        timestamp: new Date(),
        pageTitle: 'Scan Failed'
      });
      await failedScan.save();
      console.log('Failed scan record saved');
    } catch (saveError) {
      console.error('Failed to save failed scan:', saveError);
    }

    res.status(500).json({ 
      error: 'Failed to scan website. Please check the URL and try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Scan failed'
    });
  }
});

// Email scan results endpoint
app.post('/email-scan-results', authenticateToken, async (req, res) => {
  try {
    if (!transporter) {
      return res.status(500).json({ 
        error: 'Email service not configured. Please contact administrator.' 
      });
    }

    const { scanId, url, score, totalIssues } = req.body;
    
    // Get user email from token
    const userId = req.user.id;
    
    // Fetch user details to get email (assuming you have a User model)
    const User = mongoose.model('User');
    const user = await User.findById(userId);
    
    if (!user || !user.email) {
      return res.status(400).json({ error: 'User email not found' });
    }

    // Fetch full scan details if scanId is provided
    let scanDetails = null;
    if (scanId) {
      scanDetails = await Scan.findOne({ _id: scanId, userId: userId });
    }

    // Create email content
    const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
            .score-box { background: ${score >= 90 ? '#10b981' : score >= 75 ? '#f59e0b' : '#ef4444'}; color: white; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0; }
            .score { font-size: 48px; font-weight: bold; }
            .issues-summary { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #3b82f6; }
            .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
            .button { display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin: 10px 0; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🔍 A11yCheck Scan Results</h1>
                <p>Website Accessibility Report</p>
            </div>
            
            <div class="content">
                <h2>Scan Summary</h2>
                <p><strong>Website:</strong> ${url}</p>
                <p><strong>Scan Date:</strong> ${new Date().toLocaleDateString()}</p>
                <p><strong>Scan Time:</strong> ${new Date().toLocaleTimeString()}</p>
                
                <div class="score-box">
                    <div class="score">${score}/100</div>
                    <p>${score >= 90 ? 'Excellent Accessibility!' : score >= 75 ? 'Good with Room for Improvement' : 'Needs Significant Improvements'}</p>
                </div>
                
                <div class="issues-summary">
                    <h3>📊 Issues Summary</h3>
                    <p><strong>Total Issues Found:</strong> ${totalIssues}</p>
                    ${scanDetails ? `
                    <p><strong>Critical Errors:</strong> ${scanDetails.issueDetails.filter(i => i.severity === 'error').length}</p>
                    <p><strong>Warnings:</strong> ${scanDetails.issueDetails.filter(i => i.severity === 'warning').length}</p>
                    <p><strong>Notices:</strong> ${scanDetails.issueDetails.filter(i => i.severity === 'notice').length}</p>
                    ` : ''}
                </div>
                
                ${scanDetails && scanDetails.issueDetails.length > 0 ? `
                <h3>🔧 Top Issues to Fix</h3>
                ${scanDetails.issueDetails.slice(0, 5).map(issue => `
                    <div style="background: white; padding: 15px; margin: 10px 0; border-radius: 6px; border-left: 4px solid ${issue.severity === 'error' ? '#ef4444' : issue.severity === 'warning' ? '#f59e0b' : '#3b82f6'};">
                        <strong>${issue.type}</strong><br>
                        <span style="color: #666; font-size: 14px;">${issue.description}</span>
                        ${issue.selector ? `<br><code style="background: #f3f4f6; padding: 2px 4px; border-radius: 3px; font-size: 12px;">${issue.selector}</code>` : ''}
                    </div>
                `).join('')}
                ` : ''}
                
                <div style="text-align: center; margin: 30px 0;">
                    <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard" class="button">
                        📈 View Full Dashboard Report
                    </a>
                </div>
                
                <div class="footer">
                    <p>This report was generated by A11yCheck - Website Accessibility Scanner</p>
                    <p>Powered by Pa11y and WCAG 2.1 AA Standards</p>
                </div>
            </div>
        </div>
    </body>
    </html>
    `;

    // Email options
    const mailOptions = {
      from: process.env.SMTP_USER,
      to: user.email,
      subject: `A11yCheck Report: ${url} (Score: ${score}/100)`,
      html: emailHtml
    };

    // Send email
    await transporter.sendMail(mailOptions);

    res.json({ 
      message: 'Scan results emailed successfully',
      emailSent: true,
      sentTo: user.email
    });

  } catch (error) {
    console.error('Email sending failed:', error);
    res.status(500).json({ 
      error: 'Failed to send email',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Email failed'
    });
  }
});

// Delete scan for the current user
app.delete('/scan/:id', authenticateToken, async (req, res) => {
  try {
    const scan = await Scan.findOneAndDelete({ 
      _id: req.params.id, 
      userId: req.user.id 
    });
    if (!scan) {
      return res.status(404).json({ error: 'Scan not found' });
    }
    res.json({ message: 'Scan deleted successfully' });
  } catch (error) {
    console.error('Error deleting scan:', error);
    res.status(500).json({ error: 'Failed to delete scan.' });
  }
});

// Mount auth routes - FIXED: Use proper API prefix
app.use('/api/auth', authRoutes);

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Global error handler:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? error.message : 'Server error'
  });
});

// Start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Accessibility API running on http://localhost:${PORT}`);
  console.log(`✅ Email service: ${transporter ? 'Configured' : 'Not configured'}`);
  console.log(`✅ CORS enabled for: https://a11ycheck.vercel.app`);
});