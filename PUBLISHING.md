# 发布 MCP HTTP 请求工具

本文档概述了将 `MCP HTTP 请求` 工具发布到 MCP 市场或注册表的步骤。

## 先决条件

发布前，请确保您已具备：

- MCP 市场账户或注册表访问权限。
- 必要的认证令牌或凭据。
- 所有依赖项均已安装 (`npm install`)。

## 发布步骤

1.  **更新 `package.json`（如有必要）：**
    确保 `package.json` 中的 `version`、`description`、`author` 和 `license` 字段准确且最新。

2.  **运行测试（可选但推荐）：**
    如果您为工具定义了任何测试，请运行它们以确保一切按预期工作：

    ```bash
    npm test
    ```

3.  **认证（如果需要）：**
    使用您的凭据登录到 MCP 市场或注册表。此步骤因平台而异。

    示例（对于通用 npm 类注册表）：
    ```bash
    npm login --registry=YOUR_MCP_REGISTRY_URL
    ```

4.  **发布包：**
    认证成功后，您可以发布您的 MCP 工具。命令可能因 MCP 平台而异。通常，它涉及一个 `publish` 命令。

    示例：

    ```bash
    mcp publish
    ```

    或者，如果使用标准 npm 注册表：

    ```bash
    npm publish --access public --registry=https://registry.npmjs.org/
    ```

    *注意：如果您的包名已被占用或您没有权限发布到特定范围，发布命令将会失败。请相应调整您的 `package.json` 名称或范围。*
