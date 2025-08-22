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
let sshSessions = new Map(); // 存储SSH会话状态
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
    
    // 清理相关的会话
    for (const [sessionId, session] of sshSessions.entries()) {
      if (session.connectionId === connectionId) {
        sshSessions.delete(sessionId);
      }
    }
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
        commandCount: 0,
        workingDirectory: '/root' // 添加工作目录跟踪
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
      timeout: z.number().min(1000).max(300000).default(5000).describe("命令执行超时时间(毫秒)"),
      changeDirectory: z.boolean().default(false).describe("是否在执行命令前先切换到指定目录")
    }
  },
  async ({ connectionId, command, timeout = 5000, changeDirectory = false }) => {
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
      
      // 构建完整命令（包含目录切换）
      let fullCommand = command;
      if (changeDirectory && connection.workingDirectory !== '/root') {
        fullCommand = `cd ${connection.workingDirectory} && ${command}`;
      }
      
      // 执行命令
      const result = await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error(`命令执行超时 (${timeout}ms)`));
        }, timeout);
        
        connection.client.exec(fullCommand, (err, stream) => {
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

// 注册交互式SSH终端工具
server.registerTool("interactive_ssh",
  {
    title: "交互式SSH终端",
    description: "启动一个完整的交互式SSH终端会话，支持命令历史、工作目录保持等",
    inputSchema: { 
      connectionId: z.string().min(1, "连接ID不能为空").describe("SSH连接的ID"),
      sessionName: z.string().optional().describe("会话名称（用于标识会话）"),
      initialDirectory: z.string().optional().describe("初始工作目录（默认为用户主目录）")
    }
  },
  async ({ connectionId, sessionName, initialDirectory }) => {
    try {
      // 检查连接是否存在
      const connection = sshConnections.get(connectionId);
      if (!connection) {
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 启动失败: 未找到连接ID为 ${connectionId} 的SSH连接

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
              text: `❌ 启动失败: SSH连接已断开

🔗 连接信息:
- 连接ID: ${connectionId}
- 连接名称: ${connection.name}
- 服务器: ${connection.host}:${connection.port}

💡 请重新使用 connect_ssh 工具建立连接。` 
            }
          ]
        };
      }
      
      // 创建会话ID
      const sessionId = generateConnectionId();
      const session = {
        id: sessionId,
        name: sessionName || `会话_${sessionId}`,
        connectionId,
        workingDirectory: initialDirectory || connection.workingDirectory || '/root',
        commandHistory: [],
        environment: {},
        startedAt: getCurrentTimestamp(),
        lastActivity: getCurrentTimestamp(),
        isActive: true
      };
      
      // 存储会话信息
      sshSessions.set(sessionId, session);
      
      // 初始化工作目录
      if (initialDirectory && initialDirectory !== '/root') {
        try {
          await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              reject(new Error('目录切换超时'));
            }, 5000);
            
            connection.client.exec(`cd ${initialDirectory} && pwd`, (err, stream) => {
              if (err) {
                clearTimeout(timeoutId);
                reject(new Error(`目录切换失败: ${err.message}`));
                return;
              }
              
              let stdout = '';
              stream.on('data', (data) => {
                stdout += data.toString();
              });
              
              stream.on('close', (code) => {
                clearTimeout(timeoutId);
                if (code === 0) {
                  session.workingDirectory = stdout.trim();
                  resolve();
                } else {
                  reject(new Error('目录不存在或无权限'));
                }
              });
            });
          });
        } catch (error) {
          // 如果目录切换失败，使用默认目录
          session.workingDirectory = '/root';
        }
      }
      
      return {
        content: [
          { 
            type: "text", 
            text: `🚀 交互式SSH终端已启动！

🔗 会话信息:
- 会话ID: ${sessionId}
- 会话名称: ${session.name}
- 连接名称: ${connection.name}
- 服务器: ${connection.host}:${connection.port}
- 当前工作目录: ${session.workingDirectory}
- 启动时间: ${session.startedAt}

💡 使用说明:
1. 使用 execute_in_session 工具在会话中执行命令
2. 使用 get_session_info 工具查看会话状态
3. 使用 close_session 工具关闭会话
4. 会话会自动保持工作目录和命令历史

📝 支持的功能:
- 工作目录保持
- 命令历史记录
- 环境变量保持
- 会话状态管理

🎯 现在可以在 ${session.workingDirectory} 目录下执行命令了！` 
          }
        ]
      };
      
    } catch (error) {
      return {
        content: [
          { 
            type: "text", 
            text: `❌ 启动交互式终端失败: ${error.message}

🔗 连接ID: ${connectionId}

💡 请检查连接状态，或尝试重新连接。` 
          }
        ]
      };
    }
  }
);

// 注册目录切换工具
server.registerTool("change_directory",
  {
    title: "切换工作目录",
    description: "切换SSH连接的工作目录",
    inputSchema: { 
      connectionId: z.string().min(1, "连接ID不能为空").describe("SSH连接的ID"),
      directory: z.string().min(1, "目录路径不能为空").describe("要切换到的目录路径"),
      timeout: z.number().min(1000).max(30000).default(5000).describe("操作超时时间(毫秒)")
    }
  },
  async ({ connectionId, directory, timeout = 5000 }) => {
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
      
      // 验证目录是否存在
      const result = await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error(`目录检查超时 (${timeout}ms)`));
        }, timeout);
        
        connection.client.exec(`cd ${directory} && pwd`, (err, stream) => {
          if (err) {
            clearTimeout(timeoutId);
            reject(new Error(`目录切换失败: ${err.message}`));
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
            if (code === 0) {
              resolve(stdout.trim());
            } else {
              reject(new Error(`目录不存在或无权限: ${stderr.trim() || directory}`));
            }
          });
        });
      });
      
      // 更新工作目录
      connection.workingDirectory = result;
      connection.lastActivity = getCurrentTimestamp();
      
      const executionTime = Date.now() - startTime;
      updateConnectionStats('command_success', executionTime);
      
      return {
        content: [
          { 
            type: "text", 
            text: `✅ 工作目录切换成功

🔗 连接信息:
- 连接ID: ${connectionId}
- 连接名称: ${connection.name}
- 服务器: ${connection.host}:${connection.port}
- 新工作目录: ${result}
- 执行时间: ${executionTime}ms

💡 现在可以使用 execute_command 工具执行命令，系统会自动在当前工作目录下执行。

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
            text: `❌ 目录切换失败: ${error.message}

⏱️ 执行时间: ${executionTime}ms
🔗 连接ID: ${connectionId}
📝 目标目录: ${directory}

💡 可能的原因:
1. 目录不存在
2. 权限不足
3. 路径格式错误

🔍 建议:
1. 检查目录路径是否正确
2. 确认用户权限是否足够
3. 使用绝对路径` 
          }
        ]
      };
    }
  }
);

// 注册在会话中执行命令的工具
server.registerTool("execute_in_session",
  {
    title: "在会话中执行命令",
    description: "在交互式SSH会话中执行命令，保持工作目录和状态",
    inputSchema: { 
      sessionId: z.string().min(1, "会话ID不能为空").describe("SSH会话的ID"),
      command: z.string().min(1, "命令不能为空").describe("要执行的命令"),
      timeout: z.number().min(1000).max(300000).default(10000).describe("命令执行超时时间(毫秒)")
    }
  },
  async ({ sessionId, command, timeout = 10000 }) => {
    const startTime = Date.now();
    
    try {
      // 检查会话是否存在
      const session = sshSessions.get(sessionId);
      if (!session) {
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 执行失败: 未找到会话ID为 ${sessionId} 的SSH会话

💡 请使用 interactive_ssh 工具启动会话，或检查会话ID是否正确。

📋 当前活跃会话:
${Array.from(sshSessions.values()).map(sess => `- ${sess.name} (ID: ${sess.id})`).join('\n') || '无活跃会话'}` 
            }
          ]
        };
      }
      
      // 检查会话是否活跃
      if (!session.isActive) {
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 执行失败: 会话已关闭

🔗 会话信息:
- 会话ID: ${sessionId}
- 会话名称: ${session.name}
- 状态: 已关闭

💡 请重新启动会话。` 
            }
          ]
        };
      }
      
      // 检查连接是否仍然活跃
      const connection = sshConnections.get(session.connectionId);
      if (!connection || !connection.client || connection.client.closed) {
        // 清理断开的连接和会话
        cleanupConnection(session.connectionId);
        sshSessions.delete(sessionId);
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 执行失败: SSH连接已断开

🔗 会话信息:
- 会话ID: ${sessionId}
- 会话名称: ${session.name}

💡 请重新使用 connect_ssh 工具建立连接。` 
            }
          ]
        };
      }
      
      // 构建完整命令（包含目录切换和环境变量）
      let fullCommand = command;
      let shouldUpdateWorkingDirectory = false;
      
      // 如果是cd命令，需要特殊处理
      if (command.trim().startsWith('cd ')) {
        const targetDir = command.trim().substring(3).trim();
        shouldUpdateWorkingDirectory = true;
        
        // 处理相对路径和绝对路径
        if (targetDir.startsWith('/')) {
          // 绝对路径
          fullCommand = `cd ${targetDir} && pwd`;
        } else if (targetDir === '-' || targetDir === '~') {
          // 特殊目录
          fullCommand = `cd ${targetDir} && pwd`;
        } else {
          // 相对路径，需要基于当前工作目录
          fullCommand = `cd ${session.workingDirectory}/${targetDir} && pwd`;
        }
      } else {
        // 非cd命令，添加工作目录前缀
        if (session.workingDirectory !== '/root') {
          fullCommand = `cd ${session.workingDirectory} && ${command}`;
        }
      }
      
      // 执行命令
      const result = await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error(`命令执行超时 (${timeout}ms)`));
        }, timeout);
        
        connection.client.exec(fullCommand, (err, stream) => {
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
      
      // 更新会话状态
      session.lastActivity = getCurrentTimestamp();
      session.commandHistory.push({
        command: command.trim(),
        timestamp: getCurrentTimestamp(),
        exitCode: result.code,
        workingDirectory: session.workingDirectory
      });
      
      // 如果是cd命令，更新工作目录
      if (shouldUpdateWorkingDirectory && result.code === 0) {
        const lines = result.stdout.split('\n');
        const newDir = lines[lines.length - 1].trim();
        if (newDir && newDir.startsWith('/')) {
          session.workingDirectory = newDir;
          console.log(`[DEBUG] 工作目录已更新: ${newDir}`);
        }
      }
      
      // 更新连接统计
      connection.commandCount++;
      updateConnectionStats('command_success', Date.now() - startTime);
      
      // 格式化输出
      const statusIcon = result.code === 0 ? '✅' : '⚠️';
      const statusText = result.code === 0 ? '成功' : `失败 (退出码: ${result.code})`;
      
      let outputText = `${statusIcon} 命令执行${statusText}

🔗 会话信息:
- 会话ID: ${sessionId}
- 会话名称: ${session.name}
- 当前工作目录: ${session.workingDirectory}
- 执行时间: ${Date.now() - startTime}ms
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
      
      outputText += `\n\n📊 会话统计:
- 命令历史数量: ${session.commandHistory.length}
- 最后活动: ${session.lastActivity}`;
      
      return {
        content: [
          { 
            type: "text", 
            text: outputText
          }
        ]
      };
      
    } catch (error) {
      updateConnectionStats('command_failed');
      
      return {
        content: [
          { 
            type: "text", 
            text: `❌ 命令执行失败: ${error.message}

⏱️ 执行时间: ${Date.now() - startTime}ms
🔗 会话ID: ${sessionId}
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

// 注册会话信息查看工具
server.registerTool("get_session_info",
  {
    title: "查看会话信息",
    description: "查看交互式SSH会话的详细信息和状态",
    inputSchema: { 
      sessionId: z.string().min(1, "会话ID不能为空").describe("要查看的SSH会话ID")
    }
  },
  async ({ sessionId }) => {
    try {
      // 检查会话是否存在
      const session = sshSessions.get(sessionId);
      if (!session) {
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 查看失败: 未找到会话ID为 ${sessionId} 的SSH会话

💡 请使用 interactive_ssh 工具启动会话，或检查会话ID是否正确。` 
            }
          ]
        };
      }
      
      // 获取连接信息
      const connection = sshConnections.get(session.connectionId);
      const connectionInfo = connection ? 
        `${connection.name} (${connection.host}:${connection.port})` : 
        '连接已断开';
      
      // 格式化命令历史
      const commandHistoryText = session.commandHistory.length > 0 ?
        session.commandHistory.slice(-10).map((hist, index) => {
          const time = new Date(hist.timestamp).toLocaleTimeString();
          const status = hist.exitCode === 0 ? '✅' : '❌';
          return `${index + 1}. ${time} ${status} \`${hist.command}\` (${hist.workingDirectory})`;
        }).join('\n') : '无命令历史';
      
      // 计算会话时长
      const startedAt = new Date(session.startedAt);
      const now = new Date();
      const duration = Math.floor((now - startedAt) / 1000);
      
      return {
        content: [
          { 
            type: "text", 
            text: `📋 SSH会话详细信息

🔗 会话基本信息:
- 会话ID: ${session.id}
- 会话名称: ${session.name}
- 连接信息: ${connectionInfo}
- 状态: ${session.isActive ? '🟢 活跃' : '🔴 已关闭'}
- 启动时间: ${session.startedAt}
- 会话时长: ${duration}秒
- 最后活动: ${session.lastActivity}

📁 当前状态:
- 工作目录: ${session.workingDirectory}
- 命令历史数量: ${session.commandHistory.length}

📝 最近命令历史 (最近10条):
${commandHistoryText}

💡 使用说明:
- 使用 execute_in_session 工具在会话中执行命令
- 使用 close_session 工具关闭会话
- 会话会自动保持工作目录和命令历史` 
          }
        ]
      };
      
    } catch (error) {
      return {
        content: [
          { 
            type: "text", 
            text: `❌ 获取会话信息失败: ${error.message}

🔗 会话ID: ${sessionId}` 
          }
        ]
      };
    }
  }
);

// 注册工作目录重置工具
server.registerTool("reset_working_directory",
  {
    title: "重置工作目录",
    description: "重置SSH会话的工作目录到指定路径",
    inputSchema: { 
      sessionId: z.string().min(1, "会话ID不能为空").describe("要重置的SSH会话ID"),
      directory: z.string().min(1, "目标工作目录路径").describe("要设置的工作目录路径")
    }
  },
  async ({ sessionId, directory }) => {
    try {
      // 检查会话是否存在
      const session = sshSessions.get(sessionId);
      if (!session) {
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 重置失败: 未找到会话ID为 ${sessionId} 的SSH会话` 
            }
          ]
        };
      }
      
      // 检查连接是否仍然活跃
      const connection = sshConnections.get(session.connectionId);
      if (!connection || !connection.client || connection.client.closed) {
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 重置失败: SSH连接已断开` 
            }
          ]
        };
      }
      
      // 验证目录是否存在
      const result = await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('目录检查超时'));
        }, 5000);
        
        connection.client.exec(`cd ${directory} && pwd`, (err, stream) => {
          if (err) {
            clearTimeout(timeoutId);
            reject(new Error(`目录切换失败: ${err.message}`));
            return;
          }
          
          let stdout = '';
          stream.on('data', (data) => {
            stdout += data.toString();
          });
          
          stream.on('close', (code) => {
            clearTimeout(timeoutId);
            if (code === 0) {
              resolve(stdout.trim());
            } else {
              reject(new Error('目录不存在或无权限'));
            }
          });
        });
      });
      
      // 更新工作目录
      const oldDirectory = session.workingDirectory;
      session.workingDirectory = result;
      session.lastActivity = getCurrentTimestamp();
      
      return {
        content: [
          { 
            type: "text", 
            text: `✅ 工作目录重置成功

🔗 会话信息:
- 会话ID: ${sessionId}
- 会话名称: ${session.name}
- 原工作目录: ${oldDirectory}
- 新工作目录: ${result}
- 重置时间: ${session.lastActivity}

💡 现在可以在新的工作目录下执行命令了！` 
          }
        ]
      };
      
    } catch (error) {
      return {
        content: [
          { 
            type: "text", 
            text: `❌ 工作目录重置失败: ${error.message}

🔗 会话ID: ${sessionId}
📝 目标目录: ${directory}

💡 请检查目录路径是否正确，或确认用户权限是否足够。` 
          }
        ]
      };
    }
  }
);

// 注册调试工具
server.registerTool("debug_session",
  {
    title: "调试SSH会话",
    description: "调试SSH会话的内部状态和命令执行",
    inputSchema: { 
      sessionId: z.string().min(1, "会话ID不能为空").describe("要调试的SSH会话ID"),
      command: z.string().optional().describe("要测试的命令（可选）")
    }
  },
  async ({ sessionId, command }) => {
    try {
      // 检查会话是否存在
      const session = sshSessions.get(sessionId);
      if (!session) {
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 调试失败: 未找到会话ID为 ${sessionId} 的SSH会话` 
            }
          ]
        };
      }
      
      // 获取连接信息
      const connection = sshConnections.get(session.connectionId);
      if (!connection) {
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 调试失败: 连接已断开` 
            }
          ]
        };
      }
      
      let debugInfo = `🔍 SSH会话调试信息

🔗 会话状态:
- 会话ID: ${session.id}
- 会话名称: ${session.name}
- 当前工作目录: ${session.workingDirectory}
- 连接状态: ${connection.client.closed ? '已断开' : '活跃'}
- 会话状态: ${session.isActive ? '活跃' : '已关闭'}

📝 命令历史 (最近5条):
${session.commandHistory.slice(-5).map((hist, index) => {
  const time = new Date(hist.timestamp).toLocaleTimeString();
  const status = hist.exitCode === 0 ? '✅' : '❌';
  return `${index + 1}. ${time} ${status} \`${hist.command}\` (${hist.workingDirectory})`;
}).join('\n') || '无命令历史'}`;

      // 如果提供了测试命令，执行它
      if (command) {
        debugInfo += `\n\n🧪 测试命令: \`${command}\``;
        
        try {
          // 构建测试命令
          let testCommand = command;
          let shouldUpdateWorkingDirectory = false;
          
          if (command.trim().startsWith('cd ')) {
            const targetDir = command.trim().substring(3).trim();
            shouldUpdateWorkingDirectory = true;
            
            if (targetDir.startsWith('/')) {
              testCommand = `cd ${targetDir} && pwd`;
            } else if (targetDir === '-' || targetDir === '~') {
              testCommand = `cd ${targetDir} && pwd`;
            } else {
              testCommand = `cd ${session.workingDirectory}/${targetDir} && pwd`;
            }
          } else {
            if (session.workingDirectory !== '/root') {
              testCommand = `cd ${session.workingDirectory} && ${command}`;
            }
          }
          
          debugInfo += `\n🔧 实际执行命令: \`${testCommand}\``;
          debugInfo += `\n📁 预期工作目录: ${session.workingDirectory}`;
          
          // 执行测试命令
          const result = await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              reject(new Error('命令执行超时'));
            }, 5000);
            
            connection.client.exec(testCommand, (err, stream) => {
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
            });
          });
          
          debugInfo += `\n\n📊 测试结果:
- 退出码: ${result.code}
- 标准输出: ${result.stdout || '[无输出]'}
- 错误输出: ${result.stderr || '[无输出]'}`;
          
          if (shouldUpdateWorkingDirectory && result.code === 0) {
            const lines = result.stdout.split('\n');
            const newDir = lines[lines.length - 1].trim();
            if (newDir && newDir.startsWith('/')) {
              debugInfo += `\n✅ 工作目录将更新为: ${newDir}`;
            }
          }
          
        } catch (error) {
          debugInfo += `\n\n❌ 测试命令执行失败: ${error.message}`;
        }
      }
      
      return {
        content: [
          { 
            type: "text", 
            text: debugInfo
          }
        ]
      };
      
    } catch (error) {
      return {
        content: [
          { 
            type: "text", 
            text: `❌ 调试失败: ${error.message}` 
          }
        ]
      };
    }
  }
);

// 注册会话关闭工具
server.registerTool("close_session",
  {
    title: "关闭SSH会话",
    description: "关闭指定的交互式SSH会话",
    inputSchema: { 
      sessionId: z.string().min(1, "会话ID不能为空").describe("要关闭的SSH会话ID")
    }
  },
  async ({ sessionId }) => {
    try {
      // 检查会话是否存在
      const session = sshSessions.get(sessionId);
      if (!session) {
        return {
          content: [
            { 
              type: "text", 
              text: `❌ 关闭失败: 未找到会话ID为 ${sessionId} 的SSH会话

💡 请检查会话ID是否正确，或使用 get_session_info 工具查看当前会话状态。` 
            }
          ]
        };
      }
      
      // 计算会话时长
      const startedAt = new Date(session.startedAt);
      const closedAt = new Date();
      const duration = Math.floor((closedAt - startedAt) / 1000);
      
      // 关闭会话
      session.isActive = false;
      session.lastActivity = getCurrentTimestamp();
      
      // 清理会话
      sshSessions.delete(sessionId);
      
      return {
        content: [
          { 
            type: "text", 
            text: `✅ SSH会话已关闭

🔗 会话信息:
- 会话ID: ${sessionId}
- 会话名称: ${session.name}
- 会话时长: ${duration}秒
- 执行命令数: ${session.commandHistory.length}
- 关闭时间: ${closedAt.toISOString()}

📊 当前状态: ${sshSessions.size} 个活跃会话

💡 如需继续使用，请重新启动会话。` 
          }
        ]
      };
      
    } catch (error) {
      return {
        content: [
          { 
            type: "text", 
            text: `❌ 关闭会话失败: ${error.message}

🔗 会话ID: ${sessionId}

💡 请检查会话状态，或尝试强制关闭会话。` 
          }
        ]
      };
    }
  }
);

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
      
      // 格式化活跃会话信息
      let activeSessionsText = '无活跃会话';
      if (sshSessions.size > 0) {
        activeSessionsText = Array.from(sshSessions.values())
          .map(sess => {
            const startedAt = new Date(sess.startedAt);
            const now = new Date();
            const duration = Math.floor((now - startedAt) / 1000);
            return `- ${sess.name} (ID: ${sess.id})\n  工作目录: ${sess.workingDirectory}\n  会话时长: ${duration}秒\n  命令数: ${sess.commandHistory.length}`;
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

📋 活跃会话详情:
${activeSessionsText}

💡 使用说明:
1. connect_ssh - 建立SSH连接
2. interactive_ssh - 启动交互式SSH终端会话
3. execute_in_session - 在会话中执行命令（推荐）
4. execute_command - 执行远程命令（独立执行）
5. file_operation - 文件操作（上传/下载/列表/删除/创建目录）
6. disconnect_ssh - 断开SSH连接
7. get_ssh_stats - 查看统计信息
8. debug_session - 调试会话状态和命令执行
9. reset_working_directory - 重置工作目录

📁 文件操作支持:
- upload: 上传本地文件到服务器
- download: 从服务器下载文件到本地
- list: 查看服务器目录内容
- delete: 删除服务器文件
- mkdir: 创建服务器目录
- rmdir: 删除服务器目录

🖥️ 交互式终端支持:
- 工作目录保持
- 命令历史记录
- 会话状态管理
- 环境变量保持`
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