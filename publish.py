#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
智能发版工具 (基于 npm version)
支持四种发布类型：BUG修复、小功能更新、大版本更新、直接发布
利用 npm 原生的版本管理功能
"""

import json
import subprocess
import sys


def load_package_json():
    """读取 package.json 文件"""
    try:
        with open('package.json', 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        print("❌ 错误：找不到 package.json 文件")
        sys.exit(1)
    except json.JSONDecodeError:
        print("❌ 错误：package.json 文件格式不正确")
        sys.exit(1)


def run_npm_command(command, description):
    """执行 npm 命令"""
    try:
        print(f"🔄 {description}...")
        
        # 尝试不同的 npm 命令路径
        npm_commands = ['npm', 'npm.cmd', 'npm.exe']
        
        for npm_cmd in npm_commands:
            try:
                # 构建完整命令
                full_command = [npm_cmd] + command
                
                result = subprocess.run(
                    full_command,
                    capture_output=True, 
                    text=True, 
                    encoding='utf-8'
                )
                
                if result.returncode == 0:
                    print(f"✅ {description}成功！")
                    if result.stdout.strip():
                        print(f"输出：{result.stdout.strip()}")
                    return True, result.stdout
                else:
                    print(f"❌ {description}失败！")
                    if result.stderr:
                        print(f"错误信息：{result.stderr}")
                    if result.stdout:
                        print(f"输出信息：{result.stdout}")
                    return False, result.stderr
                    
            except FileNotFoundError:
                continue  # 尝试下一个命令
                
        # 如果所有命令都失败了
        print("❌ 找不到 npm 命令！请确保 Node.js 和 npm 已正确安装并在 PATH 中。")
        return False, "npm command not found"
        
    except Exception as e:
        print(f"❌ 执行命令过程中出现错误：{e}")
        return False, str(e)


def check_git_status():
    """检查 Git 工作目录状态"""
    try:
        print("🔍 检查 Git 工作目录状态...")
        
        # 检查是否有未提交的更改
        result = subprocess.run([
            'git', 'status', '--porcelain'
        ], capture_output=True, text=True, encoding='utf-8')
        
        if result.returncode == 0 and result.stdout.strip():
            print("⚠️  发现未提交的更改：")
            print(result.stdout.strip())
            print()
            
            # 询问用户是否要提交
            while True:
                try:
                    choice = input("是否要提交这些更改？(y/n): ").strip().lower()
                    if choice in ['y', 'yes', '是']:
                        return commit_changes()
                    elif choice in ['n', 'no', '否']:
                        print("❌ 发布终止：Git 工作目录不干净")
                        return False
                    else:
                        print("⚠️  请输入 y 或 n")
                except KeyboardInterrupt:
                    print("\n\n👋 操作已取消")
                    sys.exit(0)
        else:
            print("✅ Git 工作目录干净")
            return True
            
    except Exception as e:
        print(f"❌ 检查 Git 状态时出现错误：{e}")
        return False


def commit_changes():
    """提交所有更改"""
    try:
        print("📝 正在提交更改...")
        
        # 添加所有文件
        result_add = subprocess.run([
            'git', 'add', '.'
        ], capture_output=True, text=True, encoding='utf-8')
        
        if result_add.returncode != 0:
            print("❌ Git add 失败！")
            if result_add.stderr:
                print(f"错误信息：{result_add.stderr}")
            return False
        
        # 提交
        commit_message = f"🔧 发布前准备：{input('请输入提交信息（回车使用默认信息）: ').strip() or '自动提交更改'}"
        result_commit = subprocess.run([
            'git', 'commit', '-m', commit_message
        ], capture_output=True, text=True, encoding='utf-8')
        
        if result_commit.returncode != 0:
            print("❌ Git commit 失败！")
            if result_commit.stderr:
                print(f"错误信息：{result_commit.stderr}")
            return False
        
        print("✅ 更改已提交")
        return True
        
    except Exception as e:
        print(f"❌ 提交更改时出现错误：{e}")
        return False


def run_git_push():
    """推送 Git 标签到远程仓库"""
    try:
        print("📤 正在推送标签到远程仓库...")
        
        # 推送所有标签
        result = subprocess.run([
            'git', 'push', '--follow-tags'
        ], capture_output=True, text=True, encoding='utf-8')
        
        if result.returncode == 0:
            print("✅ 标签推送成功！")
            return True
        else:
            print("❌ 标签推送失败！")
            if result.stderr:
                print(f"错误信息：{result.stderr}")
            return False
            
    except Exception as e:
        print(f"❌ Git 推送过程中出现错误：{e}")
        return False


def main():
    """主函数"""
    print("=" * 50)
    print("        🚀 智能发版工具 (基于 npm version)")
    print("=" * 50)
    print()
    
    # 读取当前版本
    package_data = load_package_json()
    current_version = package_data.get('version', '1.0.0')
    
    print(f"📦 当前版本：{current_version}")
    print()
    print("请选择发布类型：")
    print("1. 🐛 BUG修复 (patch: x.y.z -> x.y.z+1)")
    print("2. ✨ 小功能更新 (minor: x.y.z -> x.y+1.0)")
    print("3. 🎉 大版本更新 (major: x.y.z -> x+1.0.0)")
    print("4. 🚀 直接发布 (保持当前版本号不变)")
    print()
    
    # 获取用户选择
    while True:
        try:
            choice = input("请输入选择 (1/2/3/4): ").strip()
            if choice in ['1', '2', '3', '4']:
                break
            else:
                print("⚠️  无效选择，请输入 1、2、3 或 4")
        except KeyboardInterrupt:
            print("\n\n👋 操作已取消")
            sys.exit(0)
    
    # 设置发布类型
    release_types = {
        '1': ('patch', 'BUG修复'),
        '2': ('minor', '小功能更新'),
        '3': ('major', '大版本更新'),
        '4': ('direct', '直接发布')
    }
    
    release_type, release_name = release_types[choice]
    
    print(f"\n📋 选择的发布类型：{release_name}")
    
    # 第一步：检查 Git 工作目录状态
    if not check_git_status():
        sys.exit(1)
    
    # 第二步：根据发布类型处理版本号
    if release_type == 'direct':
        # 直接发布：不更新版本号，只创建 Git 标签
        print("🚀 直接发布模式：保持当前版本号不变")
        new_version = current_version
        
        # 为当前版本创建 Git 标签（如果不存在）
        tag_name = f"v{current_version}"
        print(f"🏷️  为版本 {tag_name} 创建 Git 标签...")
        
        # 检查标签是否已存在
        tag_check = subprocess.run([
            'git', 'tag', '-l', tag_name
        ], capture_output=True, text=True, encoding='utf-8')
        
        if tag_check.stdout.strip():
            print(f"✅ 标签 {tag_name} 已存在")
            version_success = True
        else:
            # 创建标签
            tag_result = subprocess.run([
                'git', 'tag', tag_name
            ], capture_output=True, text=True, encoding='utf-8')
            
            if tag_result.returncode == 0:
                print(f"✅ 标签 {tag_name} 创建成功")
                version_success = True
            else:
                print(f"❌ 标签创建失败：{tag_result.stderr}")
                version_success = False
    else:
        # 常规发布：使用 npm version 更新版本号和创建 Git 标签
        version_success, version_output = run_npm_command(
            ['version', release_type, '--git-tag-version=true'],
            f"更新版本号 ({release_type})"
        )
        
        if version_success:
            # 从输出中提取新版本号
            new_version = version_output.strip() if version_output else "未知"
            if new_version.startswith('v'):
                new_version = new_version[1:]  # 移除 'v' 前缀
            print(f"✅ 版本号已从 {current_version} 更新为 {new_version}")
    
    if not version_success:
        print("❌ 版本处理失败，发布终止")
        sys.exit(1)
    
    # 第三步：发布到 npm
    publish_success, _ = run_npm_command(
        ['publish', '--access', 'public', '--registry=https://registry.npmjs.org/'],
        "发布到 npm"
    )
    
    # 第四步：推送标签到远程仓库
    git_success = False
    if publish_success:
        git_success = run_git_push()
    
    # 显示结果
    print()
    print("=" * 50)
    print("               📊 发布结果")
    print("=" * 50)
    print(f"发布类型：{release_name}")
    
    if release_type == 'direct':
        print(f"发布版本：{new_version} (版本号未变更)")
    else:
        print(f"新版本：{new_version}")
    
    print()
    
    if publish_success:
        print("✅ npm 发布成功！")
        if git_success:
            print("✅ Git 标签推送成功！")
        else:
            print("⚠️  Git 标签推送失败（但 npm 发布已完成）")
            print("💡 你可以手动运行：git push --follow-tags")
    else:
        print("❌ npm 发布失败！")
        if release_type == 'direct':
            print("💡 你可以手动运行：npm publish --access public")
        else:
            print("💡 版本号已更新，你可以手动运行：npm publish --access public")
    
    print("=" * 50)


if __name__ == "__main__":
    main()
