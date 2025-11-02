const crypto = require('crypto');
const http = require('http');

module.exports = function(RED) {
    function CameraLightNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const CAMERA_IP = config.cameraIp;
        const USERNAME = node.credentials.username;
        const PASSWORD = node.credentials.password;

        const URL = `http://${CAMERA_IP}/RPC2`;
        const LOGIN_URL = `http://${CAMERA_IP}/RPC2_Login`;

        node.log(`Camera Light Node initialized - IP: ${CAMERA_IP}, Username: ${USERNAME}`);

        // Кеш сессии
        let cachedSession = null;
        let sessionExpiry = 0;

        async function logout(session) {
            try {
                if (!session) return;
                node.log(`Logging out session: ${session.sessionId}`);
                
                await makeRequest(URL, {
                    method: "global.logout",
                    params: null,
                    id: 999,
                    session: session.sessionId
                }, session.cookies);
                
                node.log(`Logout completed`);
            } catch (error) {
                node.log(`Logout error: ${error.message}`);
            }
        }

        function makeRequest(url, data, cookies = '') {
            return new Promise((resolve, reject) => {
                const postData = JSON.stringify(data);
                const urlObj = require('url').parse(url);
                
                const options = {
                    hostname: urlObj.hostname,
                    port: urlObj.port || 80,
                    path: urlObj.path,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData),
                        'Cookie': cookies
                    },
                    timeout: 10000
                };

                const req = http.request(options, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => {
                        try {
                            const result = JSON.parse(body);
                            const setCookie = res.headers['set-cookie'];
                            resolve({ result, cookies: setCookie ? setCookie.join('; ') : '', status: res.statusCode });
                        } catch (e) {
                            reject(new Error(`JSON parse error: ${e.message}`));
                        }
                    });
                });

                req.on('error', reject);
                req.on('timeout', () => reject(new Error('Request timeout')));
                req.write(postData);
                req.end();
            });
        }

        async function login() {
            try {
                const now = Date.now();
                if (cachedSession && now < sessionExpiry) {
                    node.log(`Using cached session: ${cachedSession.sessionId}`);
                    return cachedSession;
                }
                
                if (cachedSession) {
                    await logout(cachedSession);
                    cachedSession = null;
                }
                
                node.log(`Starting login process to ${LOGIN_URL}`);
                
                let response = await makeRequest(LOGIN_URL, {
                    method: "global.login",
                    params: { userName: USERNAME, password: "", clientType: "Web3.0" },
                    id: 1
                });

                node.log(`First login response status: ${response.status}`);
                
                if (response.status !== 200) {
                    node.error(`HTTP error: ${response.status}`);
                    return null;
                }

                let result = response.result;
                node.log(`First login result: ${JSON.stringify(result)}`);
                
                let cookies = response.cookies;
                node.log(`Cookies received: ${cookies}`);

                if (!result.result && result.params && result.params.random) {
                    const realm = result.params.realm;
                    const random = result.params.random;
                    const sessionId = result.session;

                    node.log(`Challenge received - Realm: ${realm}, Random: ${random}, Session: ${sessionId}`);

                    const passwordHash = crypto.createHash('md5')
                        .update(`${USERNAME}:${realm}:${PASSWORD}`)
                        .digest('hex').toUpperCase();

                    const finalHash = crypto.createHash('md5')
                        .update(`${USERNAME}:${random}:${passwordHash}`)
                        .digest('hex').toUpperCase();

                    node.log(`Password hashes calculated`);

                    response = await makeRequest(LOGIN_URL, {
                        method: "global.login",
                        params: {
                            userName: USERNAME,
                            password: finalHash,
                            clientType: "Web3.0",
                            authorityType: "Default"
                        },
                        id: 2,
                        session: sessionId
                    }, cookies);

                    node.log(`Second login response status: ${response.status}`);
                    
                    if (response.status !== 200) {
                        node.error(`HTTP error on second login: ${response.status}`);
                        return null;
                    }

                    result = response.result;
                    node.log(`Second login result: ${JSON.stringify(result)}`);
                    
                    cookies = response.cookies;
                    
                    if (result.result) {
                        node.log(`Login successful! Session: ${result.session}`);
                        cachedSession = { sessionId: result.session, cookies };
                        sessionExpiry = now + 25 * 60 * 1000;
                        return cachedSession;
                    } else {
                        node.error(`Login failed: ${JSON.stringify(result)}`);
                        return null;
                    }
                } else if (result.result) {
                    node.log(`Direct login successful!`);
                    cachedSession = { sessionId: result.session, cookies };
                    sessionExpiry = now + 25 * 60 * 1000;
                    return cachedSession;
                } else {
                    if (result.error && result.error.code === 486) {
                        node.log(`Camera busy, waiting and retrying...`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        response = await makeRequest(LOGIN_URL, {
                            method: "global.login",
                            params: { userName: USERNAME, password: "", clientType: "Web3.0" },
                            id: 1
                        });
                        
                        if (response.status === 200) {
                            result = response.result;
                            node.log(`Retry login result: ${JSON.stringify(result)}`);
                            
                            if (result.result) {
                                cachedSession = { sessionId: result.session, cookies: response.cookies };
                                sessionExpiry = now + 25 * 60 * 1000;
                                return cachedSession;
                            }
                        }
                    }
                    
                    node.error(`Unexpected login response: ${JSON.stringify(result)}`);
                    return null;
                }
            } catch (error) {
                node.error(`Login error: ${error.message}`);
                return null;
            }
        }

        async function setLight(session, mode, brightness = 100) {
            try {
                node.log(`Setting light - Mode: ${mode}, Brightness: ${brightness}`);
                
                const configResponse = await makeRequest(URL, {
                    method: "configManager.getConfig",
                    params: { name: "Lighting_V2" },
                    id: 10,
                    session: session.sessionId
                }, session.cookies);

                node.log(`Get config response status: ${configResponse.status}`);
                
                if (configResponse.status !== 200) {
                    node.error(`HTTP error getting config: ${configResponse.status}`);
                    return { result: false, error: `HTTP ${configResponse.status}` };
                }

                const configData = configResponse.result;
                node.log(`Config data: ${JSON.stringify(configData)}`);
                
                if (!configData.result) {
                    if (configData.error && (configData.error.code === 287637504 || configData.error.code === 287637505)) {
                        node.log(`Session error (${configData.error.code}): ${configData.error.message}, clearing cache and retrying...`);
                        cachedSession = null;
                        sessionExpiry = 0;
                        return { result: false, error: 'Session error', retry: true };
                    }
                    
                    node.error(`Failed to get config: ${JSON.stringify(configData)}`);
                    return { result: false, error: 'Failed to get config' };
                }

                const table = configData.params.table;
                node.log(`Original table: ${JSON.stringify(table)}`);
                
                table[0][0][0].Mode = mode;
                table[0][0][0].PercentOfMaxBrightness = brightness;
                
                if (mode === "Manual") {
                    table[0][0][0].MiddleLight[0].Light = brightness;
                }
                
                node.log(`Modified table: ${JSON.stringify(table)}`);

                // Пробуем сначала обычный метод
                let response = await makeRequest(URL, {
                    method: "configManager.setConfig",
                    params: { name: "Lighting_V2", table, options: [] },
                    id: 20,
                    session: session.sessionId
                }, session.cookies);
                
                // Если не сработал, пробуем system.multicall
                if (response.status !== 200 || !response.result.result) {
                    node.log(`Standard method failed, trying system.multicall...`);
                    
                    response = await makeRequest(URL, {
                        method: "system.multicall",
                        params: [{
                            method: "configManager.setConfig",
                            params: { name: "Lighting_V2", table, options: [] },
                            id: 20,
                            session: session.sessionId
                        }],
                        id: 21,
                        session: session.sessionId
                    }, session.cookies);
                }

                node.log(`Set config response status: ${response.status}`);
                
                if (response.status !== 200) {
                    node.error(`HTTP error setting config: ${response.status}`);
                    return { result: false, error: `HTTP ${response.status}` };
                }

                const result = response.result;
                node.log(`Set config result: ${JSON.stringify(result)}`);
                
                return result;
            } catch (error) {
                node.error(`Set light error: ${error.message}`);
                return { result: false, error: error.message };
            }
        }

        node.on('input', async function(msg) {
            try {
                node.log(`Received input: ${JSON.stringify(msg.payload)}`);
                node.status({ fill: "blue", shape: "dot", text: "Logging in..." });
                
                const session = await login();
                if (!session) {
                    node.status({ fill: "red", shape: "ring", text: "Login failed" });
                    node.error("Failed to login to camera");
                    return;
                }

                node.status({ fill: "yellow", shape: "dot", text: "Setting light..." });

                let command = (msg.payload || "").toString().trim();
                node.log(`Processing command: ${command}`);
                
                let mode = "Off", brightness = 0;
                
                if (/^\d+$/.test(command)) {
                    mode = "Manual";
                    brightness = parseInt(command);
                    node.log(`Light Manual - Brightness: ${brightness}`);
                } 
                else if (command.toLowerCase() === "on") {
                    mode = "Manual";
                    brightness = 100;
                    node.log(`Light Manual ON - Brightness: 100`);
                }
                else if (command.toLowerCase() === "off") {
                    mode = "Off";
                    brightness = 0;
                    node.log(`Light OFF`);
                }
                else if (command.toLowerCase().startsWith("auto")) {
                    mode = "Auto";
                    const parts = command.split(" ");
                    brightness = parts.length > 1 ? parseInt(parts[1]) || 100 : 100;
                    node.log(`Light AUTO mode - Brightness: ${brightness}`);
                }
                else {
                    mode = "Off";
                    brightness = 0;
                    node.log(`Light OFF (default)`);
                }

                let result = await setLight(session, mode, brightness);
                
                if (result.retry) {
                    node.log(`Retrying with new session...`);
                    node.status({ fill: "blue", shape: "dot", text: "Re-login..." });
                    
                    const newSession = await login();
                    if (newSession) {
                        node.status({ fill: "yellow", shape: "dot", text: "Retrying..." });
                        result = await setLight(newSession, mode, brightness);
                    } else {
                        result = { result: false, error: 'Failed to re-login' };
                    }
                }
                
                node.log(`Final result: ${JSON.stringify(result)}`);
                
                node.status({ 
                    fill: result.result ? "green" : "red", 
                    shape: "dot", 
                    text: result.result ? `${command} ✓` : `${command} ✗` 
                });
                
                msg.payload = result;
                node.send(msg);
            } catch (error) {
                node.error(`Input handler error: ${error.message}`);
                node.status({ fill: "red", shape: "ring", text: "Error" });
            }
        });
    }

    RED.nodes.registerType("dahua-camera-light", CameraLightNode, {
        credentials: {
            username: { type: "text" },
            password: { type: "password" }
        }
    });
};