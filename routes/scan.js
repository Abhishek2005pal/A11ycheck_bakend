const express = require('express');
const pa11y = require('pa11y');
const Scan = require('../models/Scan');
const { authenticateToken } = require('./auth');

const router = express.Router();

// POST /scan - Create new accessibility scan
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { url } = req.body;
    const userId = req.user.id;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL is required'
      });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid URL format'
      });
    }

    console.log(`🔍 Starting Pa11y scan for: ${url}`);
    const startTime = Date.now();
    
    // Run Pa11y scan
    const results = await pa11y(url, {
      standard: 'WCAG2AA',
      wait: 2000,
      timeout: 30000,
      chromeLaunchConfig: {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      }
    });
    
    const endTime = Date.now();
    const scanDuration = endTime - startTime;
    
    console.log(`✅ Pa11y scan completed: Found ${results.issues.length} issues in ${scanDuration}ms`);
    
    // Process the issues - THIS IS THE KEY FIX!
    const processedIssues = results.issues.map((issue, index) => ({
      id: index + 1,
      type: issue.type,
      severity: issue.type, // Pa11y uses 'error', 'warning', 'notice'
      selector: issue.selector,
      message: issue.message,
      code: issue.code,
      context: issue.context || ''
    }));
    
    // Calculate score based on issues
    const errorCount = results.issues.filter(i => i.type === 'error').length;
    const warningCount = results.issues.filter(i => i.type === 'warning').length;
    const noticeCount = results.issues.filter(i => i.type === 'notice').length;
    
    // Scoring algorithm
    let score = 100;
    score -= errorCount * 10;    // Each error = -10 points
    score -= warningCount * 5;   // Each warning = -5 points  
    score -= noticeCount * 2;    // Each notice = -2 points
    score = Math.max(0, score);  // Don't go below 0
    
    // Get page metadata
    let pageTitle = 'Unknown';
    let pageDescription = '';
    
    try {
      const pageResponse = await fetch(url);
      const html = await pageResponse.text();
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
      
      if (titleMatch) pageTitle = titleMatch[1].trim();
      if (descMatch) pageDescription = descMatch[1].trim();
    } catch (metaError) {
      console.log('⚠️  Could not extract page metadata:', metaError.message);
    }
    
    // Save to database - WITH PROPER ISSUE DETAILS ARRAY
    const scanData = {
      userId,
      url,
      issues: results.issues.length,
      issueDetails: processedIssues, // This is now an array of objects!
      score,
      status: 'completed',
      timestamp: new Date(),
      scanDuration,
      pageTitle,
      pageDescription
    };
    
    console.log(`💾 Saving scan with ${processedIssues.length} processed issues`);
    
    const savedScan = await Scan.create(scanData);
    
    console.log(`✅ Scan saved with ID: ${savedScan._id}`);
    
    res.json({
      success: true,
      scanId: savedScan._id,
      message: 'Scan completed successfully',
      data: {
        id: savedScan._id.toString(),
        url: savedScan.url,
        issues: savedScan.issues,
        score: savedScan.score,
        status: savedScan.status,
        timestamp: savedScan.timestamp,
        scanDuration: savedScan.scanDuration,
        pageTitle: savedScan.pageTitle,
        pageDescription: savedScan.pageDescription,
        issueDetails: savedScan.issueDetails
      }
    });
    
  } catch (error) {
    console.error('❌ Scan error:', error);
    
    // Handle different types of errors
    if (error.message.includes('timeout')) {
      return res.status(408).json({ 
        success: false, 
        error: 'Scan timeout - website took too long to respond' 
      });
    }
    
    if (error.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
      return res.status(400).json({ 
        success: false, 
        error: 'Website not found - check the URL' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Scan failed - please try again' 
    });
  }
});

// GET /scan/:id - Get scan results
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid scan ID format' 
      });
    }
    
    const scan = await Scan.findById(id);
    
    if (!scan) {
      return res.status(404).json({ 
        success: false, 
        error: 'Scan not found' 
      });
    }
    
    // Check if user owns this scan
    if (scan.userId.toString() !== req.user.id) {
      return res.status(403).json({ 
        success: false, 
        error: 'Access denied - not your scan' 
      });
    }
    
    // Return the full scan data with proper issue details
    res.json({
      id: scan._id.toString(),
      url: scan.url,
      issues: scan.issues,
      score: scan.score,
      status: scan.status,
      timestamp: scan.timestamp,
      scanDuration: scan.scanDuration,
      pageTitle: scan.pageTitle,
      pageDescription: scan.pageDescription,
      issueDetails: scan.issueDetails || [] // This should now be an array!
    });
    
  } catch (error) {
    console.error('❌ Error fetching scan:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Error fetching scan results' 
    });
  }
});

// GET /scans - Get user's scan history
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    
    const scans = await Scan.find({ userId })
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .select('-issueDetails'); // Don't include full issue details in list view
    
    const total = await Scan.countDocuments({ userId });
    
    res.json({
      success: true,
      scans,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching scan history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Error fetching scan history' 
    });
  }
});

module.exports = router;