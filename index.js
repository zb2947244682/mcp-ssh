#!/usr/bin/env node
// 导入 MCP (Model Context Protocol) Server 类，用于创建 MCP 服务
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// 导入 StdioServerTransport 类，用于通过标准输入/输出 (stdio) 进行通信
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// 导入 zod 库，用于定义和验证数据 schema (输入参数的类型和结构)
import { z } from "zod";
// 导入 SSH2 库，用于SSH连接和命令执行
import { Client } from "ssh2";
// 导入文件系统模块，用于读取私钥文件和文件传输
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, basename } from "path";

// 创建一个 MCP 服务器实例
// 配置服务器的名称和版本
const server = new McpServer({
  name: "ssh-server", // 服务器名称
  version: "1.0.0"     // 服务器版本
});

// SSH连接管理
let sshConnections = new Map(); // 存储活跃的SSH连接
let connectionStats = {
  totalConnections: 0,
  activeConnections: 0,
  totalCommands: 0,
  successfulCommands: 0,
  failedCommands: 0,
  totalExecutionTime: 0,
  averageExecutionTime: 0
};

// 生成连接ID
function generateConnectionId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// 获取当前时间戳
function getCurrentTimestamp() {
  return new Date().toISOString();
}

// 更新连接统计信息
function updateConnectionStats(action, executionTime = 0) {
  switch (action) {
    case 'connect':
      connectionStats.totalConnections++;
      connectionStats.activeConnections++;
      break;
    case 'disconnect':
      connectionStats.activeConnections = Math.max(0, connectionStats.activeConnections - 1);
      break;
    case 'command_success':
      connectionStats.totalCommands++;
      connectionStats.successfulCommands++;
      connectionStats.totalExecutionTime += executionTime;
      connectionStats.averageExecutionTime = connectionStats.totalExecutionTime / connectionStats.totalCommands;
      break;
    case 'command_failed':
      connectionStats.totalCommands++;
      connectionStats.failedCommands++;
      break;
  }
}

// 清理断开的连接
function cleanupConnection(connectionId) {
  const connection = sshConnections.get(connectionId);
  if (connection) {
    try {
      if (connection.client && connection.client.end) {
        connection.client.end();
      }
    } catch (error) {
      // 忽略清理时的错误
    }
    sshConnections.delete(connectionId);
    updateConnectionStats('disconnect');
  }
}

// 注册SSH连接工具
server.registerTool("connect_ssh",
  {
    title: "SSH连接",
    description: "通过SSH私钥连接到远程服务器",
    inputSchema: { 
      host: z.string().min(1, "主机地址不能为空"),
      port: z.number().min(1).max(65535).default(22).describe("SSH端口号"),
      username: z.string().min(1, "用户名不能为空"),
      privateKey: z.string().optional().describe("SSH私钥内容（PEM格式）"),
      privateKeyPath: z.string().optional().describe("SSH私钥文件路径（绝对路径）"),
      passphrase: z.string().optional().describe("私钥密码（如果有的话）"),
      connectionName: z.string().optional().describe("连接名称（用于标识连接）")
    }
  },
  async ({ host, port = 22, username, privateKey, privateKeyPath, passphrase, connectionName }) => {
    const startTime = Date.now();
    
    try {
      // 检查是否已有同名连接
      if (connectionName) {
        for (const [id, conn] of sshConnections.entries()) {
          if (conn.name === connectionName) {
            return {
              content: [
                { 
                  type: "text", 
                  text: `❌ 连接失败: 已存在名为 "${connectionName}" 的连接\n\n请使用不同的连接名称，或先断开现有连接。` 
                }
              ]
            };
          }
        }
      }
      
      // 读取私钥内容
      let privateKeyContent = privateKey;
      
      // 如果提供了私钥路径，则从文件读取
      if (privateKeyPath) {
        try {
          console.log(`[DEBUG] 正在读取私钥文件: ${privateKeyPath}`);
          privateKeyContent = readFileSync(privateKeyPath, 'utf8');
          console.log(`[DEBUG] 私钥文件读取成功，长度: ${privateKeyContent.length} 字符`);
        } catch (readError) {
          throw new Error(`无法读取私钥文件 ${privateKeyPath}: ${readError.message}`);
        }
      }
      
      // 检查是否提供了私钥内容
      if (!privateKeyContent) {
        throw new Error('必须提供私钥内容或私钥文件路径');
      }
      
      // 创建SSH客户端
      const client = new Client();
      
      // 创建连接对象
      const connectionId = generateConnectionId();
      const connection = {
        id: connectionId,
        name: connectionName || `连接_${connectionId}`,
        host,
        port,
        username,
        client,
        connectedAt: getCurrentTimestamp(),
        lastActivity: getCurrentTimestamp(),
        commandCount: 0
      };
      
      // 连接配置 - 优化以减少延迟
      const config = {
        host,
        port,
        username,
        privateKey: Buffer.from(privateKeyContent, 'utf8'),
        readyTimeout: 5000, // 5秒超时
        keepaliveInterval: 5000, // 5秒心跳
        keepaliveCountMax: 3,
        algorithms: {
          serverHostKey: ['ssh-rsa', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-ed25519']
        },
        // 减少连接延迟的设置
        tryKeyboard: false,
        lookForKeys: false,
        // 禁用一些可能导致延迟的功能
        compress: false
      };
      
      // 验证私钥格式
      if (!privateKeyContent.includes('-----BEGIN OPENSSH PRIVATE KEY-----') || 
          !privateKeyContent.includes('-----END OPENSSH PRIVATE KEY-----')) {
        throw new Error('私钥格式错误：必须是OpenSSH格式的PEM私钥');
      }
      
      if (passphrase) {
        config.passphrase = passphrase;
      }
      
            // 建立连接 - 使用更可靠的异步处理
      await new Promise((resolve, reject) => {
        let isResolved = false;
        let connectionStartTime = Date.now();
        
        // 添加严格的超时控制
        const timeoutId = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            console.log(`[DEBUG] 连接超时，强制结束连接 ${host}:${port}`);
            try {
              client.end();
            } catch (e) {
              // 忽略结束时的错误
            }
            reject(new Error(`SSH连接超时 (5秒) - 已等待 ${Date.now() - connectionStartTime}ms`));
          }
        }, 5000);
        
        // 添加连接开始事件监听
        client.on('ready', () => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            console.log(`[DEBUG] SSH连接就绪 ${host}:${port}`);
            resolve();
          }
        });
        
        client.on('error', (err) => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            console.log(`[DEBUG] SSH连接错误 ${host}:${port}: ${err.message}`);
            reject(new Error(`SSH连接错误: ${err.message}`));
          }
        });
        
        client.on('timeout', () => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            console.log(`[DEBUG] SSH连接超时 ${host}:${port}`);
            reject(new Error('SSH连接超时'));
          }
        });
        
        client.on('end', () => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            console.log(`[DEBUG] SSH连接被远程关闭 ${host}:${port}`);
            reject(new Error('SSH连接被远程关闭'));
          }
        });
        
        // 添加更多事件监听器
        client.on('close', (hadError) => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            console.log(`[DEBUG] SSH连接关闭 ${host}:${port}, 有错误: ${hadError}`);
            reject(new Error('SSH连接被关闭'));
          }
        });
        
        // 尝试连接
        try {
          console.log(`[DEBUG] 开始连接 ${host}:${port}...`);
          client.connect(config);
        } catch (connectError) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            console.log(`[DEBUG] 连接启动失败 ${host}:${port}: ${connectError.message}`);
            reject(new Error(`连接启动失败: ${connectError.message}`));
          }
        }
      });
      
      // 连接成功，存储连接信息
      sshConnections.set(connectionId, connection);
      updateConnectionStats('connect');
      
      const connectionTime = Date.now() - startTime;
      
      return {
        content: [
          { 
            type: "text", 
            text: `✅ SSH连接成功建立！

🔗 连接信息:
- 连接ID: ${connectionId}
- 连接名称: ${connection.name}
- 服务器: ${host}:${port}
- 用户名: ${username}
- 连接时间: ${connectionTime}ms
- 建立时间: ${connection.connectedAt}

💡 使用说明:
1. 使用 execute_command 工具执行命令，传入 connectionId: "${connectionId}"
2. 使用 disconnect_ssh 工具断开连接，传入 connectionId: "${connectionId}"
3. 连接会自动保持活跃状态，支持长时间会话

🔑 私钥支持两种方式:
- 直接输入私钥内容 (privateKey 参数)
- 提供私钥文件路径 (privateKeyPath 参数，推荐)

📊 当前状态: ${sshConnections.size} 个活跃连接` 
          }
        ]
      };
      
    } catch (error) {
      const connectionTime = Date.now() - startTime;
      
      return {
        content: [
          { 
            type: "text", 
            text: `❌ SSH连接失败: ${error.message}

⏱️ 尝试时间: ${connectionTime}ms
🔍 连接参数:
- 主机: ${host}:${port}
- 用户名: ${username}
- 私钥来源: ${privateKeyPath ? `文件路径: ${privateKeyPath}` : '直接输入'}
- 私钥长度: ${privateKeyContent ? privateKeyContent.length : 0} 字符

💡 常见问题排查:
1. 检查主机地址和端口是否正确
2. 确认SSH服务是否运行
3. 验证私钥格式是否正确（PEM格式）
4. 检查私钥密码是否正确
5. 确认防火墙设置允许SSH连接` 
          }
        ]
      };
    }
  }
);

// 注册SSH命令执行工具
server.registerTool("execute_command",
  {
    title: "执行SSH命令",
    description: "在已连接的SSH会话中执行命令",
    inputSchema: { 
      connectionId: z.string().min(1, "连接ID不能为空").describe("SSH连接的ID"),
      command: z.string().min(1, "命令不能为空").describe("要执行的命令"),
      timeout: z.number().min(1000).max(300000).default(5000).describe("命令执行超时时间(毫秒)")
    }
  },
  async ({ connectionId, command, timeout = 5000 }) => {
    const startTime = Date.now();
    
    try {
      // 检查连接是否存在
      const connection = sshConnections.get(connectionId);
      if (!connection) {
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 执行失败: 未找到连接ID为 ${connectionId} 的SSH连接

💡 请使用 connect_ssh 工具建立连接，或检查连接ID是否正确。

📋 当前活跃连接:
${Array.from(sshConnections.values()).map(conn => `- ${conn.name} (ID: ${conn.id})`).join('\n') || '无活跃连接'}` 
            }
          ]
        };
      }
      
      // 检查连接是否仍然活跃
      if (!connection.client || connection.client.closed) {
        // 清理断开的连接
        cleanupConnection(connectionId);
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 执行失败: SSH连接已断开

🔗 连接信息:
- 连接ID: ${connectionId}
- 连接名称: ${connection.name}
- 服务器: ${connection.host}:${connection.port}

💡 请重新使用 connect_ssh 工具建立连接。` 
            }
          ]
        };
      }
      
      // 执行命令
      const result = await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error(`命令执行超时 (${timeout}ms)`));
        }, timeout);
        
        connection.client.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeoutId);
            reject(new Error(`命令执行错误: ${err.message}`));
            return;
          }
          
          let stdout = '';
          let stderr = '';
          
          stream.on('data', (data) => {
            stdout += data.toString();
          });
          
          stream.stderr.on('data', (data) => {
            stderr += data.toString();
          });
          
          stream.on('close', (code) => {
            clearTimeout(timeoutId);
            resolve({
              code,
              stdout: stdout.trim(),
              stderr: stderr.trim()
            });
          });
          
          stream.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(new Error(`流错误: ${err.message}`));
          });
        });
      });
      
      // 更新连接统计
      connection.commandCount++;
      connection.lastActivity = getCurrentTimestamp();
      
      const executionTime = Date.now() - startTime;
      updateConnectionStats('command_success', executionTime);
      
      // 格式化输出
      const statusIcon = result.code === 0 ? '✅' : '⚠️';
      const statusText = result.code === 0 ? '成功' : `失败 (退出码: ${result.code})`;
      
      let outputText = `${statusIcon} 命令执行${statusText}

🔗 连接信息:
- 连接ID: ${connectionId}
- 连接名称: ${connection.name}
- 服务器: ${connection.host}:${connection.port}
- 执行时间: ${executionTime}ms
- 退出码: ${result.code}

📝 执行的命令:
\`\`\`bash
${command}
\`\`\`

📤 标准输出:
${result.stdout || '[无输出]'}`;

      if (result.stderr) {
        outputText += `\n\n❌ 错误输出:
${result.stderr}`;
      }
      
      outputText += `\n\n📊 连接统计:
- 总命令数: ${connection.commandCount}
- 最后活动: ${connection.lastActivity}`;
      
      return {
        content: [
          { 
            type: "text", 
            text: outputText
          }
        ]
      };
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      updateConnectionStats('command_failed');
      
      return {
        content: [
          { 
            type: "text", 
            text: `❌ 命令执行失败: ${error.message}

⏱️ 执行时间: ${executionTime}ms
🔗 连接ID: ${connectionId}
📝 命令: ${command}

💡 可能的原因:
1. 命令语法错误
2. 权限不足
3. 网络连接问题
4. 命令执行超时
5. SSH连接已断开

🔍 建议:
1. 检查命令语法是否正确
2. 确认用户权限是否足够
3. 尝试重新连接SSH` 
          }
        ]
      };
    }
  }
);

// 注册SSH断开连接工具
server.registerTool("disconnect_ssh",
  {
    title: "断开SSH连接",
    description: "断开指定的SSH连接",
    inputSchema: { 
      connectionId: z.string().min(1, "连接ID不能为空").describe("要断开的SSH连接ID")
    }
  },
  async ({ connectionId }) => {
    try {
      // 检查连接是否存在
      const connection = sshConnections.get(connectionId);
      if (!connection) {
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 断开失败: 未找到连接ID为 ${connectionId} 的SSH连接

💡 请检查连接ID是否正确，或使用 get_ssh_stats 工具查看当前连接状态。` 
            }
          ]
        };
      }
      
      // 断开连接
      try {
        if (connection.client && connection.client.end) {
          connection.client.end();
        }
      } catch (error) {
        // 忽略断开时的错误
      }
      
      // 计算连接时长
      const connectedAt = new Date(connection.connectedAt);
      const disconnectedAt = new Date();
      const duration = Math.floor((disconnectedAt - connectedAt) / 1000);
      
      // 清理连接
      sshConnections.delete(connectionId);
      updateConnectionStats('disconnect');
      
      return {
        content: [
          { 
            type: "text", 
            text: `✅ SSH连接已断开

🔗 连接信息:
- 连接ID: ${connectionId}
- 连接名称: ${connection.name}
- 服务器: ${connection.host}:${connection.port}
- 用户名: ${connection.username}
- 连接时长: ${duration}秒
- 执行命令数: ${connection.commandCount}
- 断开时间: ${disconnectedAt.toISOString()}

📊 当前状态: ${sshConnections.size} 个活跃连接` 
          }
        ]
      };
      
    } catch (error) {
      return {
        content: [
          { 
            type: "text", 
            text: `❌ 断开连接失败: ${error.message}

🔗 连接ID: ${connectionId}

💡 请检查连接状态，或尝试强制断开连接。` 
          }
        ]
      };
    }
  }
);

// 注册文件操作工具（上传、下载、列表、删除等）
server.registerTool("file_operation",
  {
    title: "SSH文件操作",
    description: "支持文件上传、下载、列表查看、删除等操作",
    inputSchema: { 
      connectionId: z.string().min(1, "连接ID不能为空").describe("SSH连接的ID"),
      operation: z.enum(["upload", "download", "list", "delete", "mkdir", "rmdir"]).describe("操作类型"),
      remotePath: z.string().min(1, "远程路径不能为空").describe("远程文件/目录路径"),
      localPath: z.string().optional().describe("本地文件/目录路径（上传/下载时需要）"),
      timeout: z.number().min(10000).max(300000).default(30000).describe("操作超时时间(毫秒)")
    }
  },
  async ({ connectionId, operation, remotePath, localPath, timeout = 30000 }) => {
    const startTime = Date.now();
    
    try {
      // 检查连接是否存在
      const connection = sshConnections.get(connectionId);
      if (!connection) {
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 操作失败: 未找到连接ID为 ${connectionId} 的SSH连接

💡 请使用 connect_ssh 工具建立连接，或检查连接ID是否正确。` 
            }
          ]
        };
      }
      
      // 检查连接是否仍然活跃
      if (!connection.client || connection.client.closed) {
        cleanupConnection(connectionId);
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 操作失败: SSH连接已断开

🔗 连接信息:
- 连接ID: ${connectionId}
- 连接名称: ${connection.name}
- 服务器: ${connection.host}:${connection.port}

💡 请重新使用 connect_ssh 工具建立连接。` 
            }
          ]
        };
      }
      
      let result;
      
      switch (operation) {
        case "upload":
          if (!localPath) {
            throw new Error("上传操作需要指定本地文件路径");
          }
          if (!existsSync(localPath)) {
            throw new Error(`本地文件不存在: ${localPath}`);
          }
          result = await uploadFile(connection.client, localPath, remotePath, timeout);
          break;
          
        case "download":
          if (!localPath) {
            throw new Error("下载操作需要指定本地保存路径");
          }
          result = await downloadFile(connection.client, remotePath, localPath, timeout);
          break;
          
        case "list":
          result = await listFiles(connection.client, remotePath, timeout);
          break;
          
        case "delete":
          result = await deleteFile(connection.client, remotePath, timeout);
          break;
          
        case "mkdir":
          result = await createDirectory(connection.client, remotePath, timeout);
          break;
          
        case "rmdir":
          result = await removeDirectory(connection.client, remotePath, timeout);
          break;
          
        default:
          throw new Error(`不支持的操作类型: ${operation}`);
      }
      
      // 更新连接统计
      connection.lastActivity = getCurrentTimestamp();
      
      const executionTime = Date.now() - startTime;
      updateConnectionStats('command_success', executionTime);
      
      return {
        content: [
          { 
            type: "text", 
            text: `✅ 文件操作成功完成

🔗 连接信息:
- 连接ID: ${connectionId}
- 连接名称: ${connection.name}
- 服务器: ${connection.host}:${connection.port}
- 操作类型: ${operation}
- 执行时间: ${executionTime}ms

📋 操作详情:
${result}

📊 连接统计:
- 最后活动: ${connection.lastActivity}` 
          }
        ]
      };
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      updateConnectionStats('command_failed');
      
      return {
        content: [
          { 
            type: "text", 
            text: `❌ 文件操作失败: ${error.message}

⏱️ 执行时间: ${executionTime}ms
🔗 连接ID: ${connectionId}
📝 操作类型: ${operation}
🌐 远程路径: ${remotePath}
💻 本地路径: ${localPath || '未指定'}

💡 可能的原因:
1. 文件路径不存在或权限不足
2. 网络连接问题
3. 操作超时
4. SSH连接已断开

🔍 建议:
1. 检查文件路径是否正确
2. 确认用户权限是否足够
3. 尝试重新连接SSH` 
          }
        ]
      };
    }
  }
);

// 文件上传函数
async function uploadFile(client, localPath, remotePath, timeout) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`文件上传超时 (${timeout}ms)`));
    }, timeout);
    
    try {
      const fileContent = readFileSync(localPath);
      
      client.sftp((err, sftp) => {
        if (err) {
          clearTimeout(timeoutId);
          reject(new Error(`SFTP初始化失败: ${err.message}`));
          return;
        }
        
        sftp.writeFile(remotePath, fileContent, (writeErr) => {
          clearTimeout(timeoutId);
          if (writeErr) {
            reject(new Error(`文件上传失败: ${writeErr.message}`));
            return;
          }
          
          const stats = fileContent.length;
          resolve(`文件上传成功: ${localPath} → ${remotePath}\n文件大小: ${(stats / 1024).toFixed(2)} KB`);
        });
      });
    } catch (error) {
      clearTimeout(timeoutId);
      reject(new Error(`读取本地文件失败: ${error.message}`));
    }
  });
}

// 文件下载函数
async function downloadFile(client, remotePath, localPath, timeout) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`文件下载超时 (${timeout}ms)`));
    }, timeout);
    
    try {
      // 确保本地目录存在
      const localDir = dirname(localPath);
      if (!existsSync(localDir)) {
        mkdirSync(localDir, { recursive: true });
      }
      
      client.sftp((err, sftp) => {
        if (err) {
          clearTimeout(timeoutId);
          reject(new Error(`SFTP初始化失败: ${err.message}`));
          return;
        }
        
        sftp.readFile(remotePath, (readErr, data) => {
          clearTimeout(timeoutId);
          if (readErr) {
            reject(new Error(`文件下载失败: ${readErr.message}`));
            return;
          }
          
          try {
            writeFileSync(localPath, data);
            const stats = data.length;
            resolve(`文件下载成功: ${remotePath} → ${localPath}\n文件大小: ${(stats / 1024).toFixed(2)} KB`);
          } catch (writeError) {
            reject(new Error(`写入本地文件失败: ${writeError.message}`));
          }
        });
      });
    } catch (error) {
      clearTimeout(timeoutId);
      reject(new Error(`准备下载失败: ${error.message}`));
    }
  });
}

// 文件列表函数
async function listFiles(client, remotePath, timeout) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`文件列表获取超时 (${timeout}ms)`));
    }, timeout);
    
    client.sftp((err, sftp) => {
      if (err) {
        clearTimeout(timeoutId);
        reject(new Error(`SFTP初始化失败: ${err.message}`));
        return;
      }
      
      sftp.readdir(remotePath, (readErr, list) => {
        clearTimeout(timeoutId);
        if (readErr) {
          reject(new Error(`获取文件列表失败: ${readErr.message}`));
          return;
        }
        
        const files = list.map(item => {
          const type = item.attrs.isDirectory() ? '📁' : '📄';
          const size = item.attrs.isDirectory() ? '-' : `${(item.attrs.size / 1024).toFixed(2)} KB`;
          const date = new Date(item.attrs.mtime * 1000).toLocaleString();
          return `${type} ${item.filename.padEnd(20)} ${size.padStart(10)} ${date}`;
        });
        
        resolve(`目录: ${remotePath}\n\n${files.join('\n')}`);
      });
    });
  });
}

// 删除文件函数
async function deleteFile(client, remotePath, timeout) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`文件删除超时 (${timeout}ms)`));
    }, timeout);
    
    client.sftp((err, sftp) => {
      if (err) {
        clearTimeout(timeoutId);
        reject(new Error(`SFTP初始化失败: ${err.message}`));
        return;
      }
      
      sftp.unlink(remotePath, (unlinkErr) => {
        clearTimeout(timeoutId);
        if (unlinkErr) {
          reject(new Error(`文件删除失败: ${unlinkErr.message}`));
          return;
        }
        resolve(`文件删除成功: ${remotePath}`);
      });
    });
  });
}

// 创建目录函数
async function createDirectory(client, remotePath, timeout) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`目录创建超时 (${timeout}ms)`));
    }, timeout);
    
    client.sftp((err, sftp) => {
      if (err) {
        clearTimeout(timeoutId);
        reject(new Error(`SFTP初始化失败: ${err.message}`));
        return;
      }
        
      sftp.mkdir(remotePath, (mkdirErr) => {
        clearTimeout(timeoutId);
        if (mkdirErr) {
          reject(new Error(`目录创建失败: ${mkdirErr.message}`));
          return;
        }
        resolve(`目录创建成功: ${remotePath}`);
      });
    });
  });
}

// 删除目录函数
async function removeDirectory(client, remotePath, timeout) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`目录删除超时 (${timeout}ms)`));
    }, timeout);
    
    client.sftp((err, sftp) => {
      if (err) {
        clearTimeout(timeoutId);
        reject(new Error(`SFTP初始化失败: ${err.message}`));
        return;
      }
      
      sftp.rmdir(remotePath, (rmdirErr) => {
        clearTimeout(timeoutId);
        if (rmdirErr) {
          reject(new Error(`目录删除失败: ${rmdirErr.message}`));
          return;
        }
        resolve(`目录删除成功: ${remotePath}`);
      });
    });
  });
}

// 注册SSH统计信息工具
server.registerTool("get_ssh_stats",
  {
    title: "SSH连接统计",
    description: "获取SSH连接的统计信息和状态",
    inputSchema: {}
  },
  async () => {
    try {
      const successRate = connectionStats.totalCommands > 0 ? 
        ((connectionStats.successfulCommands / connectionStats.totalCommands) * 100).toFixed(2) : 0;
      
      // 格式化活跃连接信息
      let activeConnectionsText = '无活跃连接';
      if (sshConnections.size > 0) {
        activeConnectionsText = Array.from(sshConnections.values())
          .map(conn => {
            const connectedAt = new Date(conn.connectedAt);
            const now = new Date();
            const duration = Math.floor((now - connectedAt) / 1000);
            return `- ${conn.name} (ID: ${conn.id})\n  服务器: ${conn.host}:${conn.port}\n  用户: ${conn.username}\n  连接时长: ${duration}秒\n  命令数: ${conn.commandCount}`;
          })
          .join('\n\n');
      }
      
      return {
        content: [
          {
            type: "text",
            text: `📊 SSH连接统计信息

🔗 连接统计:
总连接数: ${connectionStats.totalConnections}
活跃连接数: ${connectionStats.activeConnections}
总命令数: ${connectionStats.totalCommands}
成功命令数: ${connectionStats.successfulCommands}
失败命令数: ${connectionStats.failedCommands}
命令成功率: ${successRate}%

⏱️ 执行时间统计:
平均执行时间: ${connectionStats.averageExecutionTime.toFixed(2)}ms
总执行时间: ${connectionStats.totalExecutionTime}ms

📋 活跃连接详情:
${activeConnectionsText}

💡 使用说明:
1. connect_ssh - 建立SSH连接
2. execute_command - 执行远程命令
3. file_operation - 文件操作（上传/下载/列表/删除/创建目录）
4. disconnect_ssh - 断开SSH连接
5. get_ssh_stats - 查看统计信息

📁 文件操作支持:
- upload: 上传本地文件到服务器
- download: 从服务器下载文件到本地
- list: 查看服务器目录内容
- delete: 删除服务器文件
- mkdir: 创建服务器目录
- rmdir: 删除服务器目录`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `❌ 获取统计信息失败: ${error.message}`
          }
        ]
      };
    }
  }
);

// 创建一个 StdioServerTransport 实例
const transport = new StdioServerTransport();

// 将 MCP 服务器连接到传输层
await server.connect(transport);

// 连接成功后打印日志，表示服务器已在运行
console.log("MCP SSH服务已启动");