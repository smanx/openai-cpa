import re
import sys
from pathlib import Path
from curl_cffi import requests

def _load_luckmail_client_class():
    """动态加载 luckmail SDK"""
    try:
        from luckmail import LuckMailClient
        return LuckMailClient
    except ImportError:
        pass
        
    candidates = [
        Path(__file__).resolve().parent / "luckmail",
        Path(__file__).resolve().parents[1] / "tools" / "luckmail",
    ]
    for path in candidates:
        if not path.is_dir(): continue
        if str(path) not in sys.path: sys.path.insert(0, str(path))
        try:
            from luckmail import LuckMailClient
            return LuckMailClient
        except Exception:
            continue
    return None

class LuckMailService:
    """直连版 LuckMail 接码服务"""
    
    def __init__(self, api_key: str, preferred_domain: str = ""):
        if not api_key:
            raise ValueError("LuckMail API_KEY 不能为空！请检查配置。")
            
        self.api_key = api_key
        self.base_url = "https://mails.luckyous.com"
        self.project_code = "openai"
        self.email_type = "ms_graph"
        self.preferred_domain = preferred_domain.strip()

        client_cls = _load_luckmail_client_class()
        if not client_cls:
            raise ValueError("未找到 LuckMail SDK！请确保本地存在 luckmail 文件夹。")

        self.client = client_cls(base_url=self.base_url + "/", api_key=self.api_key)

    def _extract_field(self, obj: any, *keys: str) -> any:
        if not obj: return None
        if isinstance(obj, dict):
            for k in keys:
                if k in obj: return obj.get(k)
        for k in keys:
            if hasattr(obj, k): return getattr(obj, k)
        return None

    def get_email_and_token(self) -> tuple:
        """抛弃 SDK，直接严格按照官方文档发起 HTTP 购号请求，彻底解决吞域名参数的问题"""
        api_url = f"{self.base_url}/api/v1/openapi/email/purchase"
        
        headers = {
            "X-API-Key": self.api_key,
            "Content-Type": "application/json"
        }
        
        payload = {
            "project_code": self.project_code,
            "email_type": self.email_type,
            "quantity": 1
        }
        
        if self.preferred_domain:
            payload["domain"] = self.preferred_domain

        try:
            resp = requests.post(api_url, headers=headers, json=payload, timeout=15)
            if resp.status_code != 200:
                raise Exception(f"HTTP {resp.status_code} - {resp.text}")
                
            res_data = resp.json()
            
            data_field = res_data.get("data")
            if not data_field:
                raise Exception(f"接口未返回 data 字段: {res_data}")

            item = None
            if isinstance(data_field, list) and data_field: 
                item = data_field[0]
            elif isinstance(data_field, dict):
                for key in ("purchases", "list", "items", "data"):
                    arr = data_field.get(key)
                    if isinstance(arr, list) and arr:
                        item = arr[0]
                        break

                if not item and "email" in data_field:
                    item = data_field

            if not item: 
                raise Exception(f"无法从结果中提取账号信息: {res_data}")

            email = str(self._extract_field(item, "email_address", "address", "email") or "").strip().lower()
            token = str(self._extract_field(item, "token") or "").strip()

            if not email or not token: 
                raise Exception(f"LuckMail 返回数据缺少 email 或 token: {item}")
                
            return email, token

        except Exception as e:
            raise Exception(f"直连 LuckMail API 购买邮箱失败: {e}")

    def get_code(self, token: str) -> str:
        """根据 token 拉取一次验证码，返回 6 位数字或空字符串"""
        result = self.client.user.get_token_code(token)
        code = str(self._extract_field(result, "verification_code") or "").strip()
        
        if code:
            match = re.search(r'\b\d{6}\b', code)
            if match:
                return match.group(0)
        return ""