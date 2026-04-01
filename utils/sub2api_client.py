import logging
import time
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple, List
from curl_cffi import requests as cffi_requests

logger = logging.getLogger(__name__)

class Sub2APIClient:
    def __init__(self, api_url: str, api_key: str):
        self.api_url = api_url.rstrip("/")
        self.headers = {
            "Content-Type": "application/json",
            "x-api-key": api_key,
        }
        self.request_kwargs = {
            "timeout": 15,
            "impersonate": "chrome110"
        }

    def _handle_response(self, response: cffi_requests.Response, success_codes: Tuple[int, ...] = (200, 201, 204)) -> Tuple[bool, Any]:
        """统一处理响应结果"""
        if response.status_code in success_codes:
            try:
                return True, response.json() if response.text else {}
            except ValueError:
                return True, response.text
                
        error_msg = f"HTTP {response.status_code}"
        try:
            detail = response.json()
            if isinstance(detail, dict):
                error_msg = detail.get("message", error_msg)
        except Exception:
            error_msg = f"{error_msg} - {response.text[:200]}"
            
        return False, error_msg

    def get_accounts(self, page: int = 1, page_size: int = 50) -> Tuple[bool, Any]:
        """获取账号列表"""
        url = f"{self.api_url}/api/v1/admin/accounts"
        params = {
            "page": page,
            "page_size": page_size
        }
        try:
            response = cffi_requests.get(url, headers=self.headers, params=params, **self.request_kwargs)
            return self._handle_response(response)
        except Exception as e:
            logger.error(f"获取账号列表异常: {e}")
            return False, str(e)

    def add_account(self, token_data: Dict[str, Any]) -> Tuple[bool, str]:
        """按照 Sub2API 要求的 sub2api-data 格式封装并上传"""
        url = f"{self.api_url}/api/v1/admin/accounts/data" 
        exported_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        
        account_item = {
            "name": token_data.get("email", "unknown"),
            "platform": "openai",
            "type": "oauth",
            "credentials": {
                "access_token": token_data.get("access_token", ""),
                "chatgpt_account_id": token_data.get("account_id", ""),
                "client_id": token_data.get("client_id", ""),
                "expires_at": int(time.time() + 864000), 
                "expires_in": 863999,
                "model_mapping": {
                    "gpt-4o": "gpt-4o",
                    "gpt-4": "gpt-4",
                    "gpt-3.5-turbo": "gpt-3.5-turbo"
                },
                "organization_id": token_data.get("workspace_id", ""),
                "refresh_token": token_data.get("refresh_token", ""),
            },
            "extra": {},
            "concurrency": 3,
            "priority": 50,
            "auto_pause_on_expired": True,
        }

        payload = {
            "data": {
                "type": "sub2api-data",
                "version": 1,
                "exported_at": exported_at,
                "proxies": [],
                "accounts": [account_item],
            },
            "skip_default_group_bind": True,
        }

        try:
            headers = self.headers.copy()
            headers["Idempotency-Key"] = f"import-{int(time.time())}"
            
            response = cffi_requests.post(
                url, 
                json=payload, 
                headers=headers, 
                timeout=30, 
                impersonate="chrome110",
                proxies=None
            )
            return self._handle_response(response, success_codes=(200, 201))
        except Exception as e:
            return False, f"网络请求异常: {str(e)}"

    def update_account(self, account_id: str, update_data: Dict[str, Any]) -> Tuple[bool, Any]:
        """更新指定账号"""
        url = f"{self.api_url}/api/v1/admin/accounts/{account_id}"
        try:
            response = cffi_requests.put(url, json=update_data, headers=self.headers, **self.request_kwargs)
            return self._handle_response(response)
        except Exception as e:
            logger.error(f"更新账号 {account_id} 异常: {e}")
            return False, str(e)

    def delete_account(self, account_id: str) -> Tuple[bool, Any]:
        """删除指定账号"""
        url = f"{self.api_url}/api/v1/admin/accounts/{account_id}"
        try:
            response = cffi_requests.delete(url, headers=self.headers, **self.request_kwargs)
            return self._handle_response(response, success_codes=(200, 204))
        except Exception as e:
            logger.error(f"删除账号 {account_id} 异常: {e}")
            return False, str(e)

    def refresh_account(self, account_id: str) -> Tuple[bool, Any]:
        """触发账号状态检查/刷新"""
        url = f"{self.api_url}/api/v1/admin/accounts/{account_id}/refresh"
        try:
            response = cffi_requests.post(url, headers=self.headers, json={}, **self.request_kwargs)
            return self._handle_response(response)
        except Exception as e:
            logger.error(f"刷新账号 {account_id} 异常: {e}")
            return False, str(e)

    def test_connection(self) -> Tuple[bool, str]:
        """测试 Sub2API 连接"""
        url = f"{self.api_url}/api/v1/admin/accounts/data"
        try:
            kwargs = self.request_kwargs.copy()
            kwargs["timeout"] = 10 
            response = cffi_requests.get(url, headers=self.headers, **kwargs)

            if response.status_code in (200, 201, 204, 405):
                return True, "Sub2API 连接测试成功，API Key 有效"
            if response.status_code == 401:
                return False, "连接成功，但 API Key 无效 (401 Unauthorized)"
            if response.status_code == 403:
                return False, "连接成功，但权限不足 (403 Forbidden)"
            return False, f"服务器返回异常状态码: {response.status_code}"
        except cffi_requests.exceptions.ConnectionError as e:
            return False, f"无法连接到服务器: {str(e)}"
        except cffi_requests.exceptions.Timeout:
            return False, "连接超时，请检查网络配置或服务器状态"
        except Exception as e:
            return False, f"连接测试失败: {str(e)}"