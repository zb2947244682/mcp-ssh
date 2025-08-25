#!/usr/bin/env node
/**
 * MCP-SSH 服务器
 * 
 * 这是一个精简而强大的SSH管理工具，提供4个核心工具：
 * 1. ssh_connection - SSH连接管理（连接/断开）
 * 2. ssh_execute - 命令执行（支持工作目录管理）
 * 3. ssh_file_operation - 文件操作（SFTP传输）
 * 4. ssh_status - 连接状态查看
 * 
 * 特点：
 * - 支持私钥文件路径和直接输入两种方式
 * - 自动工作目录管理，cd命令状态保持
 * - 完整的SFTP文件传输功能
 * - 智能错误处理和超时控制
 * 
 * 使用流程：
 * 1. 使用 ssh_connection 建立连接
 * 2. 使用 ssh_execute 执行命令
 * 3. 使用 ssh_file_operation 进行文件操作
 * 4. 使用 ssh_status 监控连接状态
 * 5. 使用 ssh_connection 断开连接
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Client } from "ssh2";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const server = new McpServer({
  name: "ssh-server",
  version: "1.0.0"
});

// SSH连接管理
let sshConnections = new Map();

// 生成连接ID
function generateConnectionId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
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
  }
}

// 1. SSH连接管理工具（连接和断开）
server.registerTool("ssh_connection",
  {
    title: "SSH连接管理",
    description: "建立SSH连接或断开现有连接。支持私钥文件路径和直接输入两种方式，自动管理连接状态。",
    inputSchema: { 
      action: z.enum(["connect", "disconnect"]).describe("操作类型：connect连接，disconnect断开"),
      host: z.string().optional().describe("主机地址（连接时必需，如：192.168.1.100 或 example.com）"),
      port: z.number().min(1).max(65535).default(22).describe("SSH端口号（默认22）"),
      username: z.string().optional().describe("用户名（连接时必需，如：root、ubuntu等）"),
      privateKey: z.string().optional().describe("SSH私钥内容（PEM格式，与privateKeyPath二选一）"),
      privateKeyPath: z.string().optional().describe("SSH私钥文件路径（绝对路径，推荐使用，如：C:\\Users\\username\\.ssh\\id_rsa）"),
      passphrase: z.string().optional().describe("私钥密码（如果私钥有密码保护）"),
      connectionName: z.string().optional().describe("连接名称（用于标识连接，如：生产服务器、测试环境等）"),
      connectionId: z.string().optional().describe("连接ID（断开连接时必需，从连接成功后的返回信息中获取）")
    }
  },
  async ({ action, host, port = 22, username, privateKey, privateKeyPath, passphrase, connectionName, connectionId }) => {
    if (action === "disconnect") {
      // 断开连接
      if (!connectionId) {
        return {
          content: [{ type: "text", text: "断开连接需要提供connectionId参数" }]
        };
      }

      const connection = sshConnections.get(connectionId);
      if (!connection) {
        return {
          content: [{ type: "text", text: `未找到连接ID为 ${connectionId} 的SSH连接` }]
        };
      }

      try {
        if (connection.client && connection.client.end) {
          connection.client.end();
        }
      } catch (error) {
        // 忽略断开时的错误
      }

      sshConnections.delete(connectionId);
      
      return {
        content: [{ 
          type: "text", 
          text: `SSH连接已断开\n连接ID: ${connectionId}\n连接名称: ${connection.name}\n服务器: ${connection.host}:${connection.port}` 
        }]
      };
    }

    // 连接SSH
    if (!host || !username) {
      return {
        content: [{ type: "text", text: "连接SSH需要提供host和username参数" }]
      };
    }

    try {
      // 检查是否已有同名连接
      if (connectionName) {
        for (const [id, conn] of sshConnections.entries()) {
          if (conn.name === connectionName) {
            return {
              content: [{ type: "text", text: `已存在名为 "${connectionName}" 的连接` }]
            };
          }
        }
      }

      // 读取私钥内容
      let privateKeyContent = privateKey;
      if (privateKeyPath) {
        try {
          privateKeyContent = readFileSync(privateKeyPath, 'utf8');
        } catch (readError) {
          throw new Error(`无法读取私钥文件 ${privateKeyPath}: ${readError.message}`);
        }
      }

      if (!privateKeyContent) {
        throw new Error('必须提供私钥内容或私钥文件路径');
      }

      // 创建SSH客户端
      const client = new Client();
      const newConnectionId = generateConnectionId();
      
      const connection = {
        id: newConnectionId,
        name: connectionName || `连接_${newConnectionId}`,
        host,
        port,
        username,
        client,
        workingDirectory: '/root'
      };

      // 连接配置
      const config = {
        host,
        port,
        username,
        privateKey: Buffer.from(privateKeyContent, 'utf8'),
        readyTimeout: 10000,
        keepaliveInterval: 5000,
        keepaliveCountMax: 3
      };

      if (passphrase) {
        config.passphrase = passphrase;
      }

      // 建立连接
      await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('SSH连接超时'));
        }, 10000);

        client.on('ready', () => {
          clearTimeout(timeoutId);
          resolve();
        });

        client.on('error', (err) => {
          clearTimeout(timeoutId);
          reject(new Error(`SSH连接错误: ${err.message}`));
        });

        client.connect(config);
      });

      // 连接成功，存储连接信息
      sshConnections.set(newConnectionId, connection);

      return {
        content: [{ 
          type: "text", 
          text: `SSH连接成功建立\n\n连接信息:\n- 连接ID: ${newConnectionId}\n- 连接名称: ${connection.name}\n- 服务器: ${host}:${port}\n- 用户名: ${username}\n\n当前活跃连接: ${sshConnections.size} 个` 
        }]
      };

    } catch (error) {
      return {
        content: [{ 
          type: "text", 
          text: `SSH连接失败: ${error.message}\n\n连接参数:\n- 主机: ${host}:${port}\n- 用户名: ${username}\n- 私钥来源: ${privateKeyPath ? `文件路径: ${privateKeyPath}` : '直接输入'}` 
        }]
      };
    }
  }
);

// 2. 执行SSH命令工具
server.registerTool("ssh_execute",
  {
    title: "执行SSH命令",
    description: "在已连接的SSH会话中执行命令。支持工作目录管理，cd命令会自动更新工作目录状态，其他命令会在当前工作目录下执行。",
    inputSchema: { 
      connectionId: z.string().min(1, "连接ID不能为空").describe("SSH连接的ID（从ssh_connection工具获取）"),
      command: z.string().min(1, "命令不能为空").describe("要执行的命令（如：ls -la、cd /var/www、pwd等）"),
      workingDirectory: z.string().optional().describe("强制指定工作目录（可选，会覆盖当前工作目录）"),
      timeout: z.number().min(1000).max(300000).default(10000).describe("命令执行超时时间（毫秒，默认10秒）")
    }
  },
  async ({ connectionId, command, workingDirectory, timeout = 10000 }) => {
    try {
      // 检查连接是否存在
      const connection = sshConnections.get(connectionId);
      if (!connection) {
        return {
          content: [{ 
            type: "text", 
            text: `执行失败: 未找到连接ID为 ${connectionId} 的SSH连接\n\n当前活跃连接:\n${Array.from(sshConnections.values()).map(conn => `- ${conn.name} (ID: ${conn.id})`).join('\n') || '无活跃连接'}` 
          }]
        };
      }

      // 检查连接是否仍然活跃
      if (!connection.client || connection.client.closed) {
        cleanupConnection(connectionId);
        return {
          content: [{ 
            type: "text", 
            text: `执行失败: SSH连接已断开\n连接ID: ${connectionId}\n连接名称: ${connection.name}` 
          }]
        };
      }

      // 更新工作目录（如果指定）
      if (workingDirectory) {
        connection.workingDirectory = workingDirectory;
      }

      // 构建完整命令（包含目录切换）
      let fullCommand = command;
      if (connection.workingDirectory && connection.workingDirectory !== '/root') {
        fullCommand = `cd ${connection.workingDirectory} && ${command}`;
      }

      // 如果是cd命令，特殊处理
      if (command.trim().startsWith('cd ')) {
        const targetDir = command.trim().substring(3).trim();
        if (targetDir.startsWith('/')) {
          fullCommand = `cd ${targetDir} && pwd`;
        } else if (targetDir === '-' || targetDir === '~') {
          fullCommand = `cd ${targetDir} && pwd`;
        } else {
          fullCommand = `cd ${connection.workingDirectory}/${targetDir} && pwd`;
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
        });
      });

      // 如果是cd命令，更新工作目录
      if (command.trim().startsWith('cd ') && result.code === 0) {
        const lines = result.stdout.split('\n');
        const newDir = lines[lines.length - 1].trim();
        if (newDir && newDir.startsWith('/')) {
          connection.workingDirectory = newDir;
        }
      }

      const statusIcon = result.code === 0 ? '✅' : '⚠️';
      const statusText = result.code === 0 ? '成功' : `失败 (退出码: ${result.code})`;

      let outputText = `${statusIcon} 命令执行${statusText}\n\n连接信息:\n- 连接ID: ${connectionId}\n- 连接名称: ${connection.name}\n- 当前工作目录: ${connection.workingDirectory}\n- 退出码: ${result.code}\n\n执行的命令:\n\`\`\`bash\n${command}\n\`\`\`\n\n标准输出:\n${result.stdout || '[无输出]'}`;

      if (result.stderr) {
        outputText += `\n\n错误输出:\n${result.stderr}`;
      }

      return {
        content: [{ type: "text", text: outputText }]
      };

    } catch (error) {
      return {
        content: [{ 
          type: "text", 
          text: `命令执行失败: ${error.message}\n\n连接ID: ${connectionId}\n命令: ${command}` 
        }]
      };
    }
  }
);

// 3. 文件操作工具
server.registerTool("ssh_file_operation",
  {
    title: "SSH文件操作",
    description: "通过SFTP协议进行文件操作，支持上传、下载、列表查看、删除、创建目录等。所有操作都基于已建立的SSH连接。",
    inputSchema: { 
      connectionId: z.string().min(1, "连接ID不能为空").describe("SSH连接的ID（从ssh_connection工具获取）"),
      operation: z.enum(["upload", "download", "list", "delete", "mkdir", "rmdir"]).describe("操作类型：upload(上传)、download(下载)、list(列表)、delete(删除)、mkdir(创建目录)、rmdir(删除目录)"),
      remotePath: z.string().min(1, "远程路径不能为空").describe("远程文件/目录路径（如：/var/www/index.html、/tmp/testdir）"),
      localPath: z.string().optional().describe("本地文件/目录路径（上传/下载时需要，如：C:\\Users\\username\\file.txt）"),
      timeout: z.number().min(10000).max(300000).default(30000).describe("操作超时时间（毫秒，默认30秒）")
    }
  },
  async ({ connectionId, operation, remotePath, localPath, timeout = 30000 }) => {
    try {
      // 检查连接是否存在
      const connection = sshConnections.get(connectionId);
      if (!connection) {
        return {
          content: [{ 
            type: "text", 
            text: `操作失败: 未找到连接ID为 ${connectionId} 的SSH连接` 
          }]
        };
      }

      // 检查连接是否仍然活跃
      if (!connection.client || connection.client.closed) {
        cleanupConnection(connectionId);
        return {
          content: [{ 
            type: "text", 
            text: `操作失败: SSH连接已断开\n连接ID: ${connectionId}` 
          }]
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

      return {
        content: [{ 
          type: "text", 
          text: `文件操作成功完成\n\n连接信息:\n- 连接ID: ${connectionId}\n- 连接名称: ${connection.name}\n- 操作类型: ${operation}\n\n操作详情:\n${result}` 
        }]
      };

    } catch (error) {
      return {
        content: [{ 
          type: "text", 
          text: `文件操作失败: ${error.message}\n\n连接ID: ${connectionId}\n操作类型: ${operation}\n远程路径: ${remotePath}\n本地路径: ${localPath || '未指定'}` 
        }]
      };
    }
  }
);

// 4. SSH状态查看工具
server.registerTool("ssh_status",
  {
    title: "SSH连接状态",
    description: "查看SSH连接的状态、工作目录和统计信息。可以查看特定连接的详细信息或所有连接的概览。",
    inputSchema: { 
      connectionId: z.string().optional().describe("查看特定连接的详细信息（可选，不提供则显示所有连接概览）")
    }
  },
  async ({ connectionId }) => {
    try {
      if (connectionId) {
        // 查看特定连接详情
        const connection = sshConnections.get(connectionId);
        if (!connection) {
          return {
            content: [{ 
              type: "text", 
              text: `未找到连接ID为 ${connectionId} 的SSH连接` 
            }]
          };
        }

        const isActive = connection.client && !connection.client.closed;
        return {
          content: [{ 
            type: "text", 
            text: `SSH连接详细信息\n\n连接信息:\n- 连接ID: ${connection.id}\n- 连接名称: ${connection.name}\n- 服务器: ${connection.host}:${connection.port}\n- 用户名: ${connection.username}\n- 状态: ${isActive ? '活跃' : '已断开'}\n- 当前工作目录: ${connection.workingDirectory}` 
          }]
        };
      }

      // 查看所有连接概览
      if (sshConnections.size === 0) {
              return {
        content: [{ 
          type: "text", 
          text: `SSH连接状态\n\n当前无活跃连接\n\n使用说明:\n1. ssh_connection - 建立或断开SSH连接（必需第一步）\n2. ssh_execute - 执行命令，支持工作目录管理\n3. ssh_file_operation - 文件传输和管理操作\n4. ssh_status - 查看连接状态和详细信息` 
        }]
      };
      }

      const connectionsText = Array.from(sshConnections.values())
        .map(conn => {
          const isActive = conn.client && !conn.client.closed;
          return `- ${conn.name} (ID: ${conn.id})\n  服务器: ${conn.host}:${conn.port}\n  用户: ${conn.username}\n  状态: ${isActive ? '活跃' : '已断开'}\n  工作目录: ${conn.workingDirectory}`;
        })
        .join('\n\n');

      return {
        content: [{ 
          type: "text", 
          text: `SSH连接状态\n\n活跃连接数: ${sshConnections.size}\n\n连接详情:\n${connectionsText}\n\n使用说明:\n1. ssh_connection - 建立或断开SSH连接（必需第一步）\n2. ssh_execute - 执行命令，支持工作目录管理\n3. ssh_file_operation - 文件传输和管理操作\n4. ssh_status - 查看连接状态和详细信息` 
        }]
      };

    } catch (error) {
      return {
        content: [{ 
          type: "text", 
          text: `获取状态信息失败: ${error.message}` 
        }]
      };
    }
  }
);

// 文件操作辅助函数
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

const transport = new StdioServerTransport();
await server.connect(transport);
//console.log("MCP SSH服务已启动");