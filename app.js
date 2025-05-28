const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// IFS Cloud config (fill as per your server)
const IFS_CONFIG = {
    baseUrl: 'https://ifsgcsc2-d02.demo.ifs.cloud',
    tokenEndpoint: '/auth/realms/gcc2d021/protocol/openid-connect/token',
    lobbiesEndpoint: '/main/ifsapplications/web/server/lobby/page/overview/Web',
    lobbyPageEndpoint: '/main/ifsapplications/web/server/lobby/page',
    clientId: 'digisigns',
    clientSecret: 'rt83sZEiJdnoBv9c5h725t76sGc36oBl',
    username: 'BRHIUS',
    password: 'W617C6cEm2ztYbQrEwt2'
};

let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
    try {
        if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
            return accessToken;
        }
        const tokenUrl = `${IFS_CONFIG.baseUrl}${IFS_CONFIG.tokenEndpoint}`;
        const params = new URLSearchParams();
        params.append('grant_type', 'password');
        params.append('client_id', IFS_CONFIG.clientId);
        params.append('client_secret', IFS_CONFIG.clientSecret);
        params.append('username', IFS_CONFIG.username);
        params.append('password', IFS_CONFIG.password);

        const response = await axios.post(tokenUrl, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10000
        });

        accessToken = response.data.access_token;
        tokenExpiry = Date.now() + (response.data.expires_in * 1000);
        return accessToken;
    } catch (error) {
        console.error('Error getting access token:', error.response?.data || error.message);
        throw error;
    }
}

async function getLobbies() {
    const token = await getAccessToken();
    const url = `${IFS_CONFIG.baseUrl}${IFS_CONFIG.lobbiesEndpoint}`;
    const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
    return response.data;
}

async function getLobbyPage(pageId) {
    const token = await getAccessToken();
    const url = `${IFS_CONFIG.baseUrl}${IFS_CONFIG.lobbyPageEndpoint}/${pageId}`;
    const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
    return response.data;
}

// Helper: Recursively get all DataSourceIds from Groups
function getAllDataSourceIds(groups) {
    let ids = new Set();
    function recurse(group) {
        if (!group) return;
        const el = group.Elements || {};
        for (let key in el) {
            let elems = Array.isArray(el[key]) ? el[key] : [el[key]];
            elems.forEach(widget => {
                if (widget && widget.DataSourceId) ids.add(widget.DataSourceId);
                // Handle LinksList/Links
                if (key === "LinksList" && widget.Links && widget.Links.Link) {
                    const linksArr = Array.isArray(widget.Links.Link) ? widget.Links.Link : [widget.Links.Link];
                    linksArr.forEach(link => {
                        if (link && link.DataSourceId) ids.add(link.DataSourceId);
                    });
                }
            });
        }
        // Nested groups? (future proofing)
        if (group.Groups && group.Groups.Group) {
            let nested = Array.isArray(group.Groups.Group) ? group.Groups.Group : [group.Groups.Group];
            nested.forEach(recurse);
        }
    }
    const arr = Array.isArray(groups.Group) ? groups.Group : [groups.Group];
    arr.forEach(recurse);
    return Array.from(ids);
}

// Helper: Fetch widget data from API (you may want to cache this for speed)
async function fetchWidgetData(dsId) {
    const token = await getAccessToken();
    // Example endpoint pattern for DataSourceId. Adjust if needed per IFS docs.
    const url = `${IFS_CONFIG.baseUrl}/main/ifsapplications/projection/v1/lobbyelementdatalist.svc/${dsId}`;
    try {
        const resp = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
        });
        // Many APIs return { value: [...] }
        return resp.data?.value || resp.data || [];
    } catch (error) {
        console.error(`Failed to fetch widget data for DataSourceId ${dsId}:`, error.response?.data || error.message);
        return [];
    }
}

// Routes
app.get('/', async (req, res) => {
    try {
        const lobbiesData = await getLobbies();
        res.render('index', { 
            lobbies: lobbiesData.pages || [],
            error: null
        });
    } catch (error) {
        res.render('index', { 
            lobbies: [],
            error: 'Failed to fetch lobbies: ' + error.message
        });
    }
});

app.get('/lobby/:pageId', async (req, res) => {
    try {
        const { pageId } = req.params;
        const lobbyData = await getLobbyPage(pageId);
        const lobbiesData = await getLobbies();
        const lobbyInfo = lobbiesData.pages?.find(page => page.pageId === pageId);

        // Extract all KPI Counters (dynamic)
        function extractKpiCounters(layoutGroups) {
            let result = [];
            if (!layoutGroups || !layoutGroups.Group) return result;
            layoutGroups.Group.forEach(g => {
                if (g.Elements && g.Elements.Counter) {
                    result = result.concat(g.Elements.Counter);
                }
            });
            return result;
        }
        const kpiCounters = extractKpiCounters(lobbyData.page.Layout.Groups);

        // Build a list of KPI IDs for API fetching
        const kpiIds = kpiCounters.map(kpi => {
            if (kpi.ProjectionDataSource && kpi.ProjectionDataSource.Filter) {
                // Extract ID from "Id eq 'XX'"
                const match = kpi.ProjectionDataSource.Filter.match(/'(\d+)'/);
                return match ? match[1] : null;
            }
            return null;
        }).filter(Boolean);

        // Helper to fetch KPI value from API (mock with static file or call actual API)
        async function fetchKpiValue(kpiId) {
            // Example: fetch from IFS API or use your sample projected.json
            const token = await getAccessToken();
            const kpiUrl = `${IFS_CONFIG.baseUrl}/main/ifsapplications/projection/v1/KPIDetailsHandling.svc/CentralKpiSet?$select=Measure&$filter=Id eq '${kpiId}'`;
            const resp = await axios.get(kpiUrl, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            });
            // If using local sample file, just require it: require('./projected.json')
            if (resp.data && resp.data.value && resp.data.value.length > 0) {
                return resp.data.value[0];
            }
            return null;
        }

        // Fetch all KPI API data in parallel and create a lookup map
        let kpiApiData = {};
        await Promise.all(kpiIds.map(async (kpiId) => {
            try {
                const apiData = await fetchKpiValue(kpiId);
                if (apiData) kpiApiData[kpiId] = apiData;
            } catch (e) {
                kpiApiData[kpiId] = { Measure: null }; // fallback
            }
        }));

        res.render('lobby', {
            lobbyData,
            lobbyInfo,
            error: null,
            kpiApiData // PASS TO EJS
        });
    } catch (error) {
        res.render('lobby', {
            lobbyData: null,
            lobbyInfo: null,
            kpiApiData: {},
            error: 'Failed to fetch lobby data: ' + error.message
        });
    }
});

// Token refresh route (unchanged)
app.post('/api/refresh-token', async (req, res) => {
    try {
        accessToken = null; // Force token refresh
        const token = await getAccessToken();
        res.json({ success: true, message: 'Token refreshed successfully' });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            details: error.response?.data || 'No additional error details',
            status: error.response?.status || 'Unknown status'
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});