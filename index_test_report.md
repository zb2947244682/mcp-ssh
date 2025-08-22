# MCP工具测试报告

## 📋 测试概要

- **测试目标**: `node D:/Codes/MCPRepo/mcp-http-requester/index.js`
- **测试时间**: 2025-08-22T04:14:11.282Z
- **测试工具版本**: 1.0.0
- **目标文件路径**: `D:/Codes/MCPRepo/mcp-http-requester/index.js`

## ✅ 兼容性检查

- **MCP协议版本**: 2024-11-05
- **连接状态**: 成功连接
- **支持的功能**: tools, resources, prompts

## 🔧 工具分析

- **工具总数**: 2
- **Schema验证**: ✅ 通过
- **安全检查**: ✅ 通过


### 🛠️ 检测到的工具列表

1. **call_url**
2. **get_stats**

### 📝 工具详细信息


#### call_url
- **描述**: Performs an HTTP request with advanced features like timeout, retry, and response formatting
- **输入参数**: url, method, headers, body, timeout, maxRetries, retryDelay, followRedirects, validateSSL
- **必需参数**: url


#### get_stats
- **描述**: Get statistics about HTTP requests made by this tool
- **输入参数**: 无
- **必需参数**: 无



## ⚡ 性能指标

- **启动时间**: 1166ms
- **平均工具执行时间**: 237ms
- **连接时间**: 3012ms

## 💡 优化建议

- 检测到 2 个工具，所有schema验证通过
- 建议添加更多错误处理和输入验证
- 性能表现良好
- 工具描述清晰，便于使用

## 📝 工具测试示例

### call_url

**测试结果**: ✅ 成功
**执行时间**: 3050ms

**请求参数**:
```json
{
  "url": "example_url",
  "method": "GET",
  "headers": {
    "example": "value"
  },
  "body": "example_body",
  "timeout": 30000,
  "maxRetries": 3,
  "retryDelay": 1000,
  "followRedirects": true,
  "validateSSL": true
}
```

**实际响应**:
```json
{
  "content": [
    {
      "type": "text",
      "text": "请求失败: 重试3次后仍然失败: Failed to parse URL from example_url\n请求时间: 3047ms\n重试次数: 3\n超时设置: 30000ms"
    }
  ]
}
```

### get_stats

**测试结果**: ✅ 成功
**执行时间**: 1ms

**请求参数**:
```json
{}
```

**实际响应**:
```json
{
  "content": [
    {
      "type": "text",
      "text": "HTTP请求统计信息:\n总请求数: 1\n成功请求数: 0\n失败请求数: 1\n成功率: 0.00%\n平均响应时间: 0.00ms"
    }
  ]
}
```


## 📊 详细测试数据

```json
{
  "test_summary": {
    "server_command": "node D:/Codes/MCPRepo/mcp-http-requester/index.js",
    "test_timestamp": "2025-08-22T04:14:11.282Z",
    "tester_version": "1.0.0",
    "target_file_path": "D:/Codes/MCPRepo/mcp-http-requester/index.js"
  },
  "compatibility": {
    "mcp_protocol_version": "2024-11-05",
    "supported_features": [
      "tools",
      "resources",
      "prompts"
    ],
    "connection_status": "成功连接"
  },
  "tools_analysis": {
    "total_tools": 2,
    "valid_schemas": true,
    "security_check": "passed",
    "tools_list": [
      "call_url",
      "get_stats"
    ],
    "tools_details": [
      {
        "name": "call_url",
        "title": "HTTP Request Tool",
        "description": "Performs an HTTP request with advanced features like timeout, retry, and response formatting",
        "inputSchema": {
          "type": "object",
          "properties": {
            "url": {
              "type": "string"
            },
            "method": {
              "type": "string",
              "default": "GET"
            },
            "headers": {
              "type": "object",
              "additionalProperties": {
                "type": "string"
              }
            },
            "body": {
              "type": "string"
            },
            "timeout": {
              "type": "number",
              "minimum": 1000,
              "maximum": 300000,
              "default": 30000
            },
            "maxRetries": {
              "type": "number",
              "minimum": 0,
              "maximum": 10,
              "default": 3
            },
            "retryDelay": {
              "type": "number",
              "minimum": 100,
              "maximum": 10000,
              "default": 1000
            },
            "followRedirects": {
              "type": "boolean",
              "default": true
            },
            "validateSSL": {
              "type": "boolean",
              "default": true
            }
          },
          "required": [
            "url"
          ],
          "additionalProperties": false,
          "$schema": "http://json-schema.org/draft-07/schema#"
        }
      },
      {
        "name": "get_stats",
        "title": "HTTP Request Statistics",
        "description": "Get statistics about HTTP requests made by this tool",
        "inputSchema": {
          "type": "object",
          "properties": {},
          "additionalProperties": false,
          "$schema": "http://json-schema.org/draft-07/schema#"
        }
      }
    ]
  },
  "performance_metrics": {
    "startup_time": 1165.7238707763286,
    "avg_tool_execution_time": 237.2765113839669,
    "connection_time": 3012
  },
  "recommendations": [
    "检测到 2 个工具，所有schema验证通过",
    "建议添加更多错误处理和输入验证",
    "性能表现良好",
    "工具描述清晰，便于使用"
  ],
  "usage_examples": [
    {
      "toolName": "call_url",
      "success": true,
      "args": {
        "url": "example_url",
        "method": "GET",
        "headers": {
          "example": "value"
        },
        "body": "example_body",
        "timeout": 30000,
        "maxRetries": 3,
        "retryDelay": 1000,
        "followRedirects": true,
        "validateSSL": true
      },
      "response": {
        "content": [
          {
            "type": "text",
            "text": "请求失败: 重试3次后仍然失败: Failed to parse URL from example_url\n请求时间: 3047ms\n重试次数: 3\n超时设置: 30000ms"
          }
        ]
      },
      "executionTime": 3050
    },
    {
      "toolName": "get_stats",
      "success": true,
      "args": {},
      "response": {
        "content": [
          {
            "type": "text",
            "text": "HTTP请求统计信息:\n总请求数: 1\n成功请求数: 0\n失败请求数: 1\n成功率: 0.00%\n平均响应时间: 0.00ms"
          }
        ]
      },
      "executionTime": 1
    }
  ]
}
```

---
*报告生成时间: 2025/8/22 12:14:11*
*测试工具: mcp-tester v1.0.0*
