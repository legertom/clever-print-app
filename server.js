/**
 * Clever OAuth Integration Server
 * 
 * This Express.js server implements OAuth 2.0 authentication flow with Clever,
 * an education technology platform that provides single sign-on for schools.
 * The server handles the complete OAuth flow from initial authentication request
 * to token exchange and user data retrieval.
 */

// Core dependencies for web server functionality
const express = require('express');
const axios = require('axios');           // HTTP client for API requests
const cors = require('cors');             // Cross-Origin Resource Sharing middleware
const helmet = require('helmet');         // Security middleware for HTTP headers
const rateLimit = require('express-rate-limit'); // Rate limiting middleware
require('dotenv').config();               // Load environment variables from .env file

/**
 * Environment Variable Validation
 * 
 * Critical security practice: validate all required environment variables at startup.
 * This prevents runtime failures and ensures proper configuration before the server
 * starts accepting requests. Failing fast is better than discovering missing config
 * during user authentication attempts.
 */
const requiredEnvVars = ['CLEVER_CLIENT_ID', 'CLEVER_CLIENT_SECRET', 'CLEVER_REDIRECT_URI'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error('Missing required environment variables:', missingVars);
    process.exit(1); // Exit with error code to indicate configuration failure
}

const app = express();

/**
 * Configuration Object
 * 
 * Centralizing configuration makes the code more maintainable and allows for
 * easy environment-specific adjustments. This pattern separates configuration
 * from business logic and makes testing easier by allowing config injection.
 */
const config = {
    port: process.env.PORT || 3000,
    clever: {
        clientId: process.env.CLEVER_CLIENT_ID,
        clientSecret: process.env.CLEVER_CLIENT_SECRET,
        redirectUri: process.env.CLEVER_REDIRECT_URI,
        baseUrl: 'https://clever.com',           // OAuth endpoints
        apiUrl: 'https://api.clever.com/v3.0'   // Data API endpoints
    }
};

/**
 * Axios Configuration
 * 
 * Setting default timeout prevents hanging requests that could exhaust server resources.
 * User-Agent header helps API providers identify and support your application.
 * Centralizing this configuration ensures consistent behavior across all HTTP requests.
 */
const axiosConfig = {
    timeout: 10000, // 10 seconds - balance between user experience and resource protection
    headers: {
        'User-Agent': 'CleverPrintApp/1.0' // Identifies your app to Clever's servers
    }
};

/**
 * Security Middleware Configuration
 * 
 * Helmet adds various HTTP security headers to protect against common vulnerabilities:
 * - X-Content-Type-Options: prevents MIME type sniffing
 * - X-Frame-Options: prevents clickjacking
 * - X-XSS-Protection: enables browser XSS filtering
 * - And many more security headers
 */
app.use(helmet());

/**
 * Rate Limiting for Authentication Routes
 * 
 * Prevents brute force attacks and abuse of OAuth endpoints. The 15-minute window
 * with 5 attempts is a reasonable balance between security and user experience.
 * Failed login attempts are common due to user error, but excessive attempts
 * indicate potential abuse.
 */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes sliding window
    max: 5, // Maximum 5 requests per IP per window
    message: 'Too many authentication attempts, please try again later.',
    standardHeaders: true,  // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false,   // Disable the `X-RateLimit-*` headers
});

// Core Express middleware setup
app.use(cors());                    // Enable cross-origin requests for frontend integration
app.use(express.static('public'));  // Serve static files (HTML, CSS, JS) from public directory
app.use(express.json());            // Parse JSON request bodies

// Apply rate limiting specifically to authentication routes
app.use('/auth', authLimiter);

/**
 * Request Logging Middleware
 * 
 * Logs all incoming requests with timestamps for debugging and monitoring.
 * In production, you'd typically use a more sophisticated logging solution
 * like Winston or Morgan, but this provides basic visibility into server activity.
 */
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next(); // Continue to next middleware
});

/**
 * JSON Escaping for HTML Embedding
 * 
 * When embedding JSON data in HTML (like in script tags), special characters
 * must be escaped to prevent XSS attacks and parsing errors. This function
 * handles all the dangerous characters that could break out of JavaScript
 * string context or inject malicious code.
 * 
 * @param {Object} obj - The object to be JSON-stringified and escaped
 * @returns {string} - Safely escaped JSON string for HTML embedding
 */
function escapeJsonForHtml(obj) {
    return JSON.stringify(obj)
        .replace(/\\/g, '\\\\')     // Escape backslashes first (order matters!)
        .replace(/'/g, "\\'")       // Escape single quotes
        .replace(/"/g, '\\"')       // Escape double quotes
        .replace(/</g, '\\u003c')   // Escape < to prevent script tag injection
        .replace(/>/g, '\\u003e');  // Escape > to prevent script tag injection
}

/**
 * Clever User Data Fetcher
 * 
 * Centralized function to fetch user data from Clever's API. This separation
 * of concerns makes the code more testable and reusable. The function handles
 * the complex orchestration of multiple API calls required to get complete
 * user information.
 * 
 * @param {string} accessToken - OAuth access token from Clever
 * @returns {Promise<Object>} - Object containing user, profile, and district data
 * @throws {Error} - If API calls fail or data structure is invalid
 */
async function fetchCleverUserData(accessToken) {
    const headers = { 'Authorization': `Bearer ${accessToken}` };
    
    try {
        // First, get basic user information to extract user ID and district ID
        const userResponse = await axios.get(`${config.clever.apiUrl}/me`, { 
            headers,
            ...axiosConfig 
        });
        
        // Extract critical IDs with safe property access
        // Using optional chaining (?.) prevents errors if API response structure changes
        const userId = userResponse.data?.data?.id;
        const districtId = userResponse.data?.data?.district;
        
        // Validate that we received the required data before proceeding
        if (!userId || !districtId) {
            throw new Error('Invalid user data structure - missing user ID or district ID');
        }
        
        /**
         * Parallel API Calls for Performance
         * 
         * Using Promise.all to fetch profile and district data simultaneously
         * reduces total request time compared to sequential requests.
         * This is safe because these requests are independent of each other.
         */
        const [profileResponse, districtResponse] = await Promise.all([
            axios.get(`${config.clever.apiUrl}/users/${userId}`, { 
                headers,
                ...axiosConfig 
            }),
            axios.get(`${config.clever.apiUrl}/districts/${districtId}`, { 
                headers,
                ...axiosConfig 
            })
        ]);
        
        // Return structured data object
        return {
            user: userResponse.data,
            profile: profileResponse.data,
            district: districtResponse.data
        };
    } catch (error) {
        // Enhanced error logging for debugging API issues
        console.error('Error fetching Clever data:', {
            message: error.message,
            response: error.response?.data,  // API error details
            status: error.response?.status   // HTTP status code
        });
        throw error; // Re-throw to be handled by calling function
    }
}

/**
 * OAuth Step 1: Initiate Authentication
 * 
 * This endpoint redirects users to Clever's authorization server.
 * The OAuth 2.0 authorization code flow begins here. We construct
 * the authorization URL with all required parameters and redirect
 * the user's browser to Clever.
 */
app.get('/auth/clever', (req, res) => {
    const redirectUri = config.clever.redirectUri;
    const clientId = config.clever.clientId;
    
    // Debug logging for troubleshooting OAuth configuration issues
    console.log('Client ID:', clientId);
    console.log('Redirect URI:', redirectUri);
    
    /**
     * OAuth Authorization URL Construction
     * 
     * Parameters explained:
     * - client_id: Identifies your application to Clever
     * - redirect_uri: Where Clever sends the user after authorization (must match registered URI)
     * - response_type: 'code' indicates we want an authorization code (not implicit flow)
     * - scope: Permissions we're requesting (read access to various Clever resources)
     */
    const authUrl = `${config.clever.baseUrl}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=read:user_id read:districts read:schools read:teachers read:students`;
    
    console.log('Full auth URL:', authUrl);
    res.redirect(authUrl); // Send user to Clever for authentication
});

/**
 * OAuth Step 2: Handle Authorization Callback
 * 
 * Clever redirects users back to this endpoint after authentication.
 * We receive an authorization code that must be exchanged for an access token.
 * This is the most complex part of the OAuth flow and requires careful
 * error handling due to the multiple API calls involved.
 */
app.get('/auth/clever/callback', async (req, res) => {
    const { code } = req.query; // Extract authorization code from query parameters
    
    /**
     * Enhanced Input Validation
     * 
     * Validates the authorization code before processing. OAuth codes should
     * be substantial strings - checking length helps catch obviously invalid codes.
     * This prevents unnecessary API calls with invalid data.
     */
    if (!code || typeof code !== 'string' || code.length < 10) {
        console.error('Invalid authorization code received:', code);
        return res.status(400).send('Invalid authorization code provided');
    }

    try {
        /**
         * Token Exchange
         * 
         * Exchange the authorization code for an access token. This is a server-to-server
         * request that includes the client secret, which is why this must happen on the
         * backend (never expose client secrets to frontend code).
         */
        const tokenResponse = await axios.post(`${config.clever.baseUrl}/oauth/tokens`, {
            client_id: config.clever.clientId,
            client_secret: config.clever.clientSecret,
            code: code,
            grant_type: 'authorization_code',        // OAuth 2.0 grant type
            redirect_uri: config.clever.redirectUri  // Must match the original redirect URI
        }, axiosConfig);

        const { access_token } = tokenResponse.data;
        
        // Validate that we received an access token
        if (!access_token) {
            throw new Error('No access token received from Clever');
        }
        
        console.log('=== FETCHING AVAILABLE CLEVER DATA ===');

        // Fetch comprehensive user data using our helper function
        const cleverData = await fetchCleverUserData(access_token);

        /**
         * Data Compilation
         * 
         * Structure the data for frontend consumption. We include auth info
         * (with truncated token for security) and all the user data we fetched.
         * The placeholder objects for schools, teachers, etc. indicate where
         * additional data could be fetched if needed.
         */
        const availableData = {
            authInfo: {
                token: access_token.substring(0, 20) + '...', // Truncate for security
                tokenType: 'Bearer',
                scopes: 'District SSO - Basic Access'
            },
            me: cleverData.user,
            userProfile: cleverData.profile,
            district: cleverData.district,
            // Placeholder structures for additional data that could be fetched
            schools: { count: 0, data: [], available: false },
            teachers: { count: 0, data: [], available: false },
            students: { count: 0, data: [], available: false },
            sections: { count: 0, data: [], available: false },
            myTeacherSections: { count: 0, data: [], available: false }
        };

        console.log('Successfully fetched available data!');
        
        // Safely escape the data for HTML embedding
        const escapedData = escapeJsonForHtml(availableData);
        
        /**
         * Success Response with Data Transfer
         * 
         * We return an HTML page that stores the authentication data in localStorage
         * and redirects to the main application. This pattern allows us to transfer
         * data from the server-side OAuth flow to the client-side application.
         * 
         * The immediate redirect provides a seamless user experience while the
         * localStorage storage makes the data available to the frontend application.
         */
        res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Clever Login Success</title>
    <script>
        // Store authentication data in browser's localStorage
        localStorage.setItem('cleverData', '${escapedData}');
        // Redirect to main application with success indicator
        window.location.href = '/?login=success';
    </script>
</head>
<body>
    <p>Processing login...</p>
</body>
</html>
        `);

    } catch (error) {
        /**
         * Comprehensive Error Handling
         * 
         * OAuth flows can fail for many reasons: network issues, invalid credentials,
         * expired codes, API changes, etc. We log detailed error information for
         * debugging while providing user-friendly error messages.
         */
        console.error('OAuth Error Details:', {
            message: error.message,
            response: error.response?.data,      // API-specific error details
            status: error.response?.status,      // HTTP status code
            timestamp: new Date().toISOString()  // When the error occurred
        });
        
        /**
         * Error Message Extraction
         * 
         * Try to extract meaningful error messages from the API response,
         * falling back to generic messages if specific details aren't available.
         * This provides better user experience than raw error objects.
         */
        const errorMessage = error.response?.data?.error_description || 
                            error.response?.data?.error || 
                            error.message || 
                            'Authentication failed';
        
        // Redirect to main app with error information
        res.redirect(`/?login=error&message=${encodeURIComponent(errorMessage)}`);
    }
});

/**
 * Server Startup
 * 
 * Start the Express server and log startup information.
 * Including the environment helps with debugging deployment issues.
 */
app.listen(config.port, () => {
    console.log(`Server running on http://localhost:${config.port}`);
    console.log('Environment:', process.env.NODE_ENV || 'development');
});