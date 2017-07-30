const http = require('http');
const https = require('https');
const net = require("net");
const url = require("url");
const zlib = require('zlib');
const fs = require('fs');
const hexdump = require('hexdump');
let log_file = 'log.txt';

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'

class ProxyServer {

    start(port) {
        // 存储本应是 https 的链接 url
        this._urlMap = {};

        const server = http.createServer();

        // handle http
        server.on('request', this.onRequest.bind(this));
        server.on('connect', this.onConnect);

        // handle errors
        server.on('clientError', (err, socket) => {
            console.log('clientError:', err.stack);
        });
        server.on('error', (err) => {
            console.log('serverError:', err.stack);
        });

        // listen
        server.listen(port, () => {
            console.log('HTTP Proxy Server Listen Port:', port);
        })
    }

    onRequest(request, response) {
        let request_url = request.method + ' http://' + request.headers.host + request.url
        console.log(request_url);
        console.log(request.headers);
        fs.appendFileSync(log_file, request_url);
        fs.appendFileSync(log_file, "\n");
        fs.appendFileSync(log_file, JSON.stringify(request.headers));
        fs.appendFileSync(log_file, "\n");

        request.on('data', function(body) {
            console.log(hexdump(body));
            fs.appendFileSync(log_file, body);
            fs.appendFileSync(log_file, "\n");
        });

        let useSSL = this.shouldBeHttps(request);
        let options = this.getRequestOptions(request, useSSL);
        let client = useSSL ? https : http;

        // 向真正的服务器发出请求
        let remoteRequest = client.request(options, (remoteResponse) => {
            // strip location header
            let locationHeader = remoteResponse.headers.location;
            if (locationHeader && locationHeader.includes('https')) {
                remoteResponse.headers.location = locationHeader.replace('https:', 'http:');
                this.updateUrlMap(remoteResponse.headers.location);
            }

            // 对于 html 响应中的链接进行修改
            let contentType = remoteResponse.headers['content-type'];
            if (contentType && contentType.includes('html')) {
                this.stripSSL(remoteResponse, response);
            } else {
                remoteResponse.pipe(response);
                response.writeHead(remoteResponse.statusCode, remoteResponse.headers);
                response.pipe(remoteResponse);
            }

            remoteResponse.on('data', function(body) {

                console.log(remoteResponse.headers)
                console.log(hexdump(body));

                console.log("-------------------------------------------------------------------------")
                fs.appendFileSync(log_file, JSON.stringify(remoteResponse.headers));
                fs.appendFileSync(log_file, "\n");
                fs.appendFileSync(log_file, body);
                fs.appendFileSync(log_file, "\n");
                fs.appendFileSync(log_file, "-------------------------------------------------------------------------\n");
            });
        })

        remoteRequest.on('error', (err) => {
            console.log('Forward RequestError:', options.host + ':' + options.port + options.path);
            response.writeHead(502, 'Proxy fetch failed');
        })

        request.pipe(remoteRequest);
    }

    /**
     * 判断是否本来应该是 https 的请求
     */
    shouldBeHttps(request) {
        let requestUrl = request.headers.host + url.parse(request.url).pathname;
        return this._urlMap[requestUrl];
    }

    /**
     * 记录本应是 https 请求的 url
     */
    updateUrlMap(httpsLink) {
        // 处理 Url ，只保留 hostname 和 pathname
        let parseObj = url.parse(httpsLink);
        let handledUrl = parseObj.hostname + parseObj.pathname;
        console.log('strip Url: https://', handledUrl);
        this._urlMap[handledUrl] = true;
    }

    /**
     * 获取发出请求的参数
     */
    getRequestOptions(request, useSSL) {

        let hostInfo = request.headers.host.split(':');
        let path = request.headers.path || url.parse(request.url).path;
        let defaultPort = useSSL ? 443 : 80;
        if (request.method === 'POST') {
            //request.headers['X-Requested-With'] = 'XMLHttpRequest';
            //request.headers['accept'] = 'application/json';
        }
        return {
            host: hostInfo[0],
            port: hostInfo[1] || defaultPort,
            path: path,
            method: request.method,
            headers: request.headers
        }
    }

    /**
     * 修改从服务器返回的响应内容
     * 更改内容中的 https 链接为 http
     * 并返回给客户端
     */
    stripSSL(remoteResponse, response) {
        let inputStream, outputStream;
        // 如果是压缩了的，需要先解压缩再更改内容
        if (remoteResponse.headers['content-encoding'] === 'gzip') {
            inputStream = zlib.createGunzip();
            outputStream = zlib.createGzip();
        } else if (remoteResponse.headers['content-encoding'] === 'deflate') {
            inputStream = zlib.createInflateRaw();
            outputStream = zlib.createDeflateRaw();
        }

        if (inputStream) {
            remoteResponse.pipe(inputStream);
            outputStream.pipe(response);
        } else {
            inputStream = remoteResponse;
            outputStream = response;
        }

        let body = [];
        inputStream.on('data', (chunk) => {
            body.push(chunk);
        })
        inputStream.on('end', () => {
            let html = Buffer.concat(body).toString();
            let urlRegex = /"(https:\/\/[\w\d:#@%\/;$()~_?\+-=\\\.&]*)"/g;
            html = html.replace(urlRegex, (match, $1) => {
                this.updateUrlMap($1);
                return match.replace('https', 'http');
            })

            outputStream.end(html);
        })

        inputStream.on('error', (err) => {
            console.log('zliberror:', err);
        })

        delete remoteResponse.headers['content-length'];
        response.writeHead(remoteResponse.statusCode, remoteResponse.headers);
        response.pipe(remoteResponse);
    }

    onConnect(request, socket, head) {
        console.log('tcp connected');
    }
}

class HttpsProxy {

    start(port) {

        var options = {
            key: fs.readFileSync('ca.key'),
            cert: fs.readFileSync('ca.crt'),
            rejectUnauthorized: false,
            secure: false
        }

        const server = https.createServer(options);

        // handle https
        server.on('request', this.onRequest.bind(this));
        server.on('connect', this.onConnect);

        // handle errors
        server.on('tlsClientError', (err, socket) => {
            console.log('tlsClientError:', err.stack);
        });
        server.on('error', (err) => {
            console.log('serverError:', err.stack);
        });

        // listen
        server.listen(port, () => {
            console.log('HTTPS Proxy Server Listen Port:', port);
        })
    }

    onRequest(request, response) {
        let request_url = request.method + ' https://' + request.headers.host + request.url
        console.log(request_url);
        console.log(request.headers);
        fs.appendFileSync(log_file, request_url);
        fs.appendFileSync(log_file, "\n");
        fs.appendFileSync(log_file, JSON.stringify(request.headers));
        fs.appendFileSync(log_file, "\n");

        request.on('data', function(body) {
            console.log(hexdump(body));
            fs.appendFileSync(log_file, body);
            fs.appendFileSync(log_file, "\n");
        });

        let options = this.getRequestOptions(request);

        // 向真正的服务器发出请求
        let remoteRequest = https.request(options, (remoteResponse) => {


            // 对于 html 响应中的链接进行修改
            remoteResponse.pipe(response);
            response.writeHead(remoteResponse.statusCode, remoteResponse.headers);
            response.pipe(remoteResponse);

            remoteResponse.on('data', function(body) {
                console.log(remoteResponse.headers)
                console.log(hexdump(body));
                console.log("-------------------------------------------------------------------------")
                fs.appendFileSync(log_file, JSON.stringify(remoteResponse.headers));
                fs.appendFileSync(log_file, "\n");
                fs.appendFileSync(log_file, body);
                fs.appendFileSync(log_file, "\n");
                fs.appendFileSync(log_file, "-------------------------------------------------------------------------\n");
            });
        })

        remoteRequest.on('error', (err) => {
            console.log('Forward RequestError:', options.host + ':' + options.port + options.path);
            response.writeHead(502, 'Proxy fetch failed');
        })

        request.pipe(remoteRequest);
    }

    /**
     * 获取发出请求的参数
     */
    getRequestOptions(request) {

        let hostInfo = request.headers.host.split(':');
        let path = request.headers.path || url.parse(request.url).path;
        let defaultPort = 443;
        return {
            host: hostInfo[0],
            port: hostInfo[1] || defaultPort,
            path: path,
            method: request.method,
            headers: request.headers,
        }
    }


    onConnect(request, socket, head) {
         console.log('tls connected');
        let options = {
            host: request.url.split(':')[0],
            port: request.url.split(':')[1] || 443
        }

        socket.on('error', (err) => {
            console.log('Https socket error');
        })

        let tunnel = net.createConnection(options, () => {
            let content = 'HTTP/1.1 200 Connection established\r\nConnection: keep-alive\r\n\r\n';
            socket.write(content, 'UTF-8', () => {
                tunnel.pipe(socket);
                socket.pipe(tunnel);
            })
        })

        tunnel.on('error', (err) => {
            console.log('Https connect to server error');
        })

    }

}

let proxy = new ProxyServer();
proxy.start(8080);
let proxy1 = new HttpsProxy();
proxy1.start(8443);
