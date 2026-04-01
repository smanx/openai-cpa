const { createApp } = Vue;

createApp({
    data() {
        return {
            isLoggedIn: !!localStorage.getItem('auth_token'),
            loginPassword: '',
            currentTab: 'console',
			showAccountsPlaintext: false,
            isRunning: false,
            tabs: [
                { id: 'console', name: '运行主页', icon: '💻' },
                { id: 'accounts', name: '账号库存', icon: '📦' },
                { id: 'email', name: '邮箱配置', icon: '📧' },
				{ id: 'cf_routes', name: 'CF 路由', icon: '🌍' },
                { id: 'proxy', name: '网络代理', icon: '🌐' },
                { id: 'relay', name: '中转管仓', icon: '☁️' },
                { id: 'concurrency', name: '并发与系统', icon: '⚙️' }
            ],
			cfGlobalStatus: null,
			isLoadingSync: false,
			cfRoutes: [],
            selectedCfRoutes: [],
			cfGlobalStatusList: [],
            isLoadingCfRoutes: false,
			isDeletingAccounts: false,
			isDeletingCfRoutes: false,
			subDomainModal: {
				show: false,
				email: '',
				key: '',
				count: 10,
				sync: false,
				loading: false
			},
			tempSubDomains: [],
            logs: [],
            config: null,
            blacklistStr: "",
            warpListStr: "",
            accounts: [],
            selectedAccounts: [],
			currentPage: 1,
            pageSize: 10,
            totalAccounts: 0,
            ws: null,
            stats: {
                success: 0, failed: 0, retries: 0, total: 0, target: 0,
                success_rate: '0.0%', elapsed: '0.0s', avg_time: '0.0s', progress_pct: '0%',
                mode: '未启动'
            },
            statsTimer: null,

            showPwd: {
                login: false, web: false, cf: false, imap: false, 
                free_token: false, free_pass: false,
                cm: false, mc: false, clash: false, cpa: false, sub2api: false,
                cf_key: false, cf_modal_key: false 
            },

            toasts: [],
            toastId: 0,
            confirmModal: { show: false, message: '', resolve: null }
        };
    },
    mounted() {
        if (this.isLoggedIn) {
            this.initApp();
        }
    },
    beforeUnmount() {
        if(this.statsTimer) clearInterval(this.statsTimer);
    },
	computed: {
        totalPages() {
            return Math.ceil(this.totalAccounts / this.pageSize) || 1;
        }
    },
    methods: {
        showToast(message, type = 'info') {
            const id = this.toastId++;
            this.toasts.push({ id, message, type });
            setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id); }, 3500);
        },

        async customConfirm(message) {
            return new Promise((resolve) => {
                this.confirmModal = { show: true, message, resolve };
            });
        },
        handleConfirm(result) {
            if (this.confirmModal.resolve) this.confirmModal.resolve(result);
            this.confirmModal.show = false;
        },
        async authFetch(url, options = {}) {
            const token = localStorage.getItem('auth_token');
            if (!options.headers) options.headers = {};
            options.headers['Authorization'] = 'Bearer ' + token;
            if (options.body && typeof options.body === 'string') {
                options.headers['Content-Type'] = 'application/json';
            }
            const res = await fetch(url, options);
            if (res.status === 401) {
                this.logout();
                this.showToast("登录状态过期，请重新登录！", "warning");
                throw new Error("Unauthorized");
            }
            return res;
        },

        async handleLogin() {
            if(!this.loginPassword) { this.showToast("请输入密码！", "warning"); return; }
            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: this.loginPassword })
                });
                const data = await res.json();
                if (data.status === 'success') {
                    localStorage.setItem('auth_token', data.token); 
                    this.isLoggedIn = true;
                    this.initApp();
                    this.showToast("登录成功，欢迎回来！", "success");
                } else { this.showToast(data.message, "error"); }
            } catch (e) { this.showToast("登录请求失败，请检查后端服务。", "error"); }
        },
        logout() {
            localStorage.removeItem('auth_token');
            this.isLoggedIn = false;
            this.loginPassword = '';
            Object.keys(this.showPwd).forEach(k => this.showPwd[k] = false);
            if(this.ws) this.ws.close();
            if(this.statsTimer) clearInterval(this.statsTimer);
        },
        initApp() {
            this.fetchConfig();
            this.fetchAccounts();
            this.initWebSocket();
            this.startStatsPolling();
        },
        startStatsPolling() {
            if(this.statsTimer) clearInterval(this.statsTimer);
            this.pollStats();
            this.statsTimer = setInterval(this.pollStats, 1000);
        },
        async pollStats() {
            if(!this.isLoggedIn) return;
            try {
                const res = await this.authFetch('/api/stats');
                const data = await res.json();
                this.stats = data;
                this.isRunning = data.is_running;
            } catch(e){}
        },
        async fetchConfig() {
            try {
                const res = await this.authFetch('/api/config');
                this.config = await res.json();
                if(this.config.clash_proxy_pool && Array.isArray(this.config.clash_proxy_pool.blacklist)) {
                    this.blacklistStr = this.config.clash_proxy_pool.blacklist.join('\n');
                }
                if(Array.isArray(this.config.warp_proxy_list)) {
                    this.warpListStr = this.config.warp_proxy_list.join('\n');
                }
            } catch (e) {}
        },
        async saveConfig() {
            try {
                if(this.config.clash_proxy_pool) {
                    this.config.clash_proxy_pool.blacklist = this.blacklistStr.split('\n').map(s => s.trim()).filter(s => s);
                }
                this.config.warp_proxy_list = this.warpListStr.split('\n').map(s => s.trim()).filter(s => s);
                const res = await this.authFetch('/api/config', {
                    method: 'POST', body: JSON.stringify(this.config)
                });
                const data = await res.json();
                if(data.status === 'success') {
                    this.showToast(data.message, "success");
                    this.pollStats();
                } else { this.showToast("保存失败：" + data.message, "error"); }
            } catch (e) { this.showToast("保存失败网络异常", "error"); }
        },
		async fetchAccounts(isManual = false) {
            if (isManual) {
                this.currentPage = 1;
            }
            try {
                const res = await this.authFetch(`/api/accounts?page=${this.currentPage}&page_size=${this.pageSize}`);
                const data = await res.json();
                if(data.status === 'success') {
                    this.accounts = data.data ? data.data : data;
                    if (data.total !== undefined) {
                        this.totalAccounts = data.total;
                    } else {
                        this.totalAccounts = this.accounts.length;
                    }
                    
                    this.selectedAccounts = []; 
                    if (isManual) this.showToast("账号列表已刷新！", "success");
                }
            } catch (e) {
                console.error("获取账号列表失败:", e);
            }
        },
		changePage(newPage) {
            if (newPage < 1 || newPage > this.totalPages) return;
            this.currentPage = newPage;
            this.selectedAccounts = []; 
            this.fetchAccounts(false);
        },
		changePageSize() {
            this.currentPage = 1;
            
            this.selectedAccounts = []; 
            
            this.fetchAccounts(false);
        },
        switchTab(tabId) {
            this.currentTab = tabId;
            if (tabId === 'accounts') {
                this.fetchAccounts();
            }
        },
        async exportSelectedAccounts() {
            if (this.selectedAccounts.length === 0) {
                this.showToast("请先勾选需要导出的账号", "warning");
                return;
            }
            
            const emails = this.selectedAccounts.map(acc => acc.email);
            
            try {
                const res = await this.authFetch('/api/accounts/export_selected', {
                    method: 'POST',
                    body: JSON.stringify({ emails: emails })
                });
                const result = await res.json();
                
                if (result.status === 'success') {
                    result.data.forEach((tokenObj, index) => {
                        setTimeout(() => {
                            const accEmail = tokenObj.email || "unknown";
                            const parts = accEmail.split('@');
                            const prefix = parts[0] || "user";
                            const domain = parts[1] || "domain";

                            const ts = Math.floor(Date.now() / 1000) + index;
                            const filename = `token_${prefix}_${domain}_${ts}.json`;
                            const jsonString = JSON.stringify(tokenObj, null, 4);
                            const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
                            const url = window.URL.createObjectURL(blob);
                            
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = filename;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            window.URL.revokeObjectURL(url);
                        }, index * 300);
                    });
                    
                    this.showToast(`🎉 成功触发 ${result.data.length} 个独立 Token 文件的下载！`, "success");
                    this.selectedAccounts = [];
                } else {
                    this.showToast(result.message, "warning");
                }
            } catch (e) {
                this.showToast("导出请求失败，请检查网络", "error");
            }
        },
		maskEmail(email) {
            if (!email) return '';
            const parts = email.split('@');
            if (parts.length !== 2) return '******'; 
            
            const name = parts[0];
            const maskedDomain = '***.***';
            
            if (name.length <= 3) {
                return name + '***@' + maskedDomain;
            }
            return name.substring(0, 3) + '***@' + maskedDomain;
        },
		exportAccountsToTxt() {
			if (this.selectedAccounts.length === 0) return;

			const textContent = this.selectedAccounts
				.map(acc => `${acc.email}----${acc.password}`)
				.join('\n');

			const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			
			const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
			link.download = `accounts_login_${dateStr}.txt`;
			
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			URL.revokeObjectURL(url);

			this.showToast(`成功导出 ${this.selectedAccounts.length} 个账号到 TXT`, 'success');
		},
		async deleteSelectedAccounts() {
            if (this.selectedAccounts.length === 0) return;

            const confirmed = await this.customConfirm(`⚠️ 危险操作：\n\n确定要彻底删除选中的 ${this.selectedAccounts.length} 个账号吗？\n删除后数据将无法恢复！`);
            if (!confirmed) return;
			this.isDeletingAccounts = true;
            try {
                const emailsToDelete = this.selectedAccounts.map(acc => acc.email);
                
                const res = await this.authFetch('/api/accounts/delete', {
                    method: 'POST',
                    body: JSON.stringify({ emails: emailsToDelete })
                });
                
                const data = await res.json();
                
                if (data.status === 'success') {
                    this.showToast(`成功物理删除 ${emailsToDelete.length} 个账号`, 'success');
                    this.selectedAccounts = [];
                    this.fetchAccounts();
                } else {
                    this.showToast('删除失败: ' + data.message, 'error');
                }
            } catch (error) {
                this.showToast('删除请求异常，请检查后端', 'error');
            } finally {
				this.isDeletingAccounts = false;
			}
        },
        toggleAll(event) {
            if (event.target.checked) this.selectedAccounts = [...this.accounts];
            else this.selectedAccounts = [];
        },

		async toggleSystem() {
			if (this.isRunning) {
				await this.stopTask();
			} else {
				let mode = 'normal';
				if (this.config?.cpa_mode?.enable) mode = 'cpa';
				if (this.config?.sub2api_mode?.enable) mode = 'sub2api';
				await this.startTask(mode);
			}
		},
        async startTask(mode) {
            try {
                const res = await this.authFetch(`/api/start?mode=${mode}`, { method: 'POST' });
                const data = await res.json();
                if (data.status === 'success') {
                    this.isRunning = true;
                    this.currentTab = 'console';
                    this.pollStats();
                    this.showToast(`启动成功`, "success");
                } else { this.showToast(data.message, "error"); }
            } catch (e) { this.showToast("启动请求发送失败", "error"); }
        },
        async stopTask() {
            try {
                const res = await this.authFetch('/api/stop', { method: 'POST' });
                const data = await res.json();
                this.showToast(data.message, "info");
                this.pollStats();
            } catch (e) {}
        },
        
        async bulkPushCPA() {
            if (!this.config.cpa_mode.enable) {
                this.showToast("🚫 请先开启 CPA 巡检并填写 API", "warning"); return;
            }
            if (this.selectedAccounts.length === 0) return;
            const confirmed = await this.customConfirm(`确定推送到 CPA？`);
            if (!confirmed) return;
            this.currentTab = 'console';
            for (let i = 0; i < this.selectedAccounts.length; i++) {
                const acc = this.selectedAccounts[i];
                try {
                    await this.authFetch('/api/account/action', {
                        method: 'POST', body: JSON.stringify({ email: acc.email, action: 'push' })
                    });
                } catch (e) {}
                await new Promise(r => setTimeout(r, 500));
            }
            this.showToast(`批量推送完毕！`, "success");
            this.selectedAccounts = []; 
        },
		async bulkPushSub2API() {
            if (!this.config.sub2api_mode.enable) {
                this.showToast("🚫 请先开启 Sub2API 模式并填写参数", "warning"); return;
            }
            if (this.selectedAccounts.length === 0) return;
            const confirmed = await this.customConfirm(`确定推送到 Sub2API？`);
            if (!confirmed) return;
            this.currentTab = 'console';
            for (let i = 0; i < this.selectedAccounts.length; i++) {
                const acc = this.selectedAccounts[i];
                try {
                    await this.authFetch('/api/account/action', {
                        method: 'POST', body: JSON.stringify({ email: acc.email, action: 'push_sub2api' })
                    });
                } catch (e) {}
                await new Promise(r => setTimeout(r, 500));
            }
            this.showToast(`批量推送完毕！`, "success");
            this.selectedAccounts = []; 
        },
        async triggerAccountAction(account, action) {
            if (action === 'push' && !this.config.cpa_mode.enable) {
                this.showToast("🚫 无法推送：请先配置 CPA 参数！", "warning"); return;
            }
            try {
                const res = await this.authFetch('/api/account/action', {
                    method: 'POST', body: JSON.stringify({ email: account.email, action: action })
                });
                const result = await res.json();
                this.showToast(result.message, result.status);
            } catch (e) {}
        },
        async clearLogs() {
            this.logs = []; 
            try { await this.authFetch('/api/logs/clear', { method: 'POST' }); } catch (e) {}
        },
        initWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const token = localStorage.getItem('auth_token');
            this.ws = new WebSocket(`${protocol}//${window.location.host}/ws/logs?token=${token}`);
            this.ws.onmessage = (event) => {
                const lines = event.data.split('\n');
                
                lines.forEach(rawText => {
                    rawText = rawText.trim();
                    if (!rawText) return;
                    
                    let logObj = { parsed: false, raw: rawText };

                    const regex = /^\[(.*?)\]\s*\[(.*?)\]\s+(.*)$/;
                    const match = rawText.match(regex);
                    
                    if (match) {
                        logObj = {
                            parsed: true,
                            time: match[1],
                            level: match[2].toUpperCase(),
                            text: match[3],
                            raw: rawText
                        };
                    }
                    
                    this.logs.push(logObj);
                });

                if (this.logs.length > 2000) {
                    this.logs.splice(0, this.logs.length - 2000);
                }

                this.$nextTick(() => {
                    const container = document.getElementById('terminal-container');
                    if (container) {
                        const isScrolledToBottom = container.scrollHeight - container.clientHeight <= container.scrollTop + 50;
                        if (isScrolledToBottom || this.logs.length < 50) {
                            container.scrollTop = container.scrollHeight;
                        }
                    }
                });
            };

            this.ws.onclose = (event) => {
                if (event.code === 1008) {
                    this.logout();
                    this.showToast("WebSocket 安全鉴权失败，请重新登录！", "error");
                    return;
                }
                if(this.isLoggedIn) {
                    setTimeout(this.initWebSocket, 3000);
                }
            };
        },
		handleSubDomainToggle() {
			if (this.config.enable_sub_domains) {
				this.subDomainModal.email = this.config.cf_api_email || '';
				this.subDomainModal.key = this.config.cf_api_key || '';
				this.subDomainModal.show = true;
			}
		},
		async executeGenerateDomainsOnly() {
			if (!this.config.mail_domains) return this.showToast('请先填写上方的主发信域名池！', 'warning');
			
			const count = this.config.sub_domain_count || 10; 

			try {
				const res = await this.authFetch('/api/config/generate_subdomains', {
					method: 'POST',
					body: JSON.stringify({
						main_domains: this.config.mail_domains,
						count: count,
						api_email: this.config.cf_api_email || '',
						api_key: this.config.cf_api_key || '',
						sync: false
					})
				});
				const data = await res.json();
				if (data.status === 'success') {
					this.config.sub_domains_list = data.domains;
					this.showToast('生成成功！如需推送到 CF，请点击右侧推送按钮。', 'success');
				} else {
					this.showToast(data.message, 'error');
				}
			} catch (e) {
				this.showToast('生成接口请求失败', 'error');
			}
		},

		async executeSyncToCF() {
			const rawList = this.config.sub_domains_list || '';
			const subDomains = rawList.split(',').map(d => d.trim()).filter(d => d);
			
			if (subDomains.length === 0) return this.showToast('当前没有可同步的二级域名，请先点击生成！', 'warning');
			if (!this.config.cf_api_email || !this.config.cf_api_key) return this.showToast('请填写 CF 账号邮箱和 API Key！', 'warning');
			const confirmed = await this.customConfirm(`即将把 ${subDomains.length} 个域名多线程推送到 Cloudflare，确定继续吗？`);
			if (!confirmed) return;
			this.isLoadingSync = true;
			this.showToast('🚀 多线程同步中，请耐心等待...', 'info');

			try {
				const res = await this.authFetch('/api/config/sync_cf_domains', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						sub_domains: subDomains.join(','),
						api_email: this.config.cf_api_email,
						api_key: this.config.cf_api_key
					})
				});
				
				const data = await res.json();
				if (data.status === 'success') {
					this.showToast('✅ 同步指令已发出，正在为您跳转并刷新状态...', 'success');
					setTimeout(async () => {
						this.currentTab = 'cf_routes'; 
						if (typeof this.fetchCfRoutes === 'function') {
							console.log("正在自动拉取最新线上列表...");
							await this.fetchCfRoutes(); 
						}
						if (typeof this.checkCfGlobalStatus === 'function') {
							this.checkCfGlobalStatus();
						}
						
						this.showToast('🚀 线上列表已自动更新！', 'success');
					}, 800);

					// =========================================

				} else {
					this.showToast(data.message || '同步失败', 'error');
				}
			} catch (e) {
				console.error('CF Sync Error:', e);
				this.showToast('同步接口请求异常', 'error');
			} finally {
				this.isLoadingSync = false; 
			}
		},
		async checkCfGlobalStatus() {
			if (!this.config.mail_domains) return;
			
			const domains = this.config.mail_domains;
			
			try {
				const res = await this.authFetch(`/api/config/cf_global_status?main_domain=${encodeURIComponent(domains)}`);
				const data = await res.json();
				if (data.status === 'success') {
					this.cfGlobalStatusList = data.data; 
				}
			} catch (e) {
				console.error("无法获取 CF 路由全局状态", e);
			}
		},
		async fetchCfRoutes() {
			if (!this.config.mail_domains) return this.showToast('请先填写主发信域名池 (用于反推Zone ID)！', 'warning');
			if (!this.config.cf_api_email || !this.config.cf_api_key) return this.showToast('请填写 CF 账号邮箱和 API Key！', 'warning');

			this.isLoadingCfRoutes = true;
			this.showToast('🔍 正在连线 Cloudflare 查询线上路由记录...', 'info');

			try {
				const res = await this.authFetch('/api/config/query_cf_domains', {
					method: 'POST',
					body: JSON.stringify({
						main_domains: this.config.mail_domains,
						api_email: this.config.cf_api_email,
						api_key: this.config.cf_api_key
					})
				});
				const data = await res.json();
				if (data.status === 'success') {
					if (data.domains) {
						this.cfRoutes = data.domains.split(',').filter(d=>d).map(d => ({ 
							domain: d, 
							loading: false
						}));
					} else {
						this.cfRoutes = [];
					}
					this.selectedCfRoutes = [];
					this.showToast(data.message, 'success');
				} else {
					this.showToast(data.message, 'error');
				}
				await this.checkCfGlobalStatus();
			} catch (e) {
				this.showToast('查询接口请求失败', 'error');
			} finally {
				this.isLoadingCfRoutes = false;
			}
		},

		async deleteSelectedCfRoutes() {
			if (this.selectedCfRoutes.length === 0) return;
			const domainsToDelete = this.selectedCfRoutes.map(item => item.domain);
			
			this.isDeletingCfRoutes = true;
			try {
				await this.executeDeleteCfDomains(domainsToDelete);
			} finally {
				this.isDeletingCfRoutes = false;
			}
		},

		async deleteSingleCfRoute(routeObj) {
			routeObj.loading = true; 
			try {
				await this.executeDeleteCfDomains([routeObj.domain]);
			} finally {
				routeObj.loading = false;
			}
		},

		async executeDeleteCfDomains(domainsArray) {
			if (!this.config.cf_api_email || !this.config.cf_api_key) return this.showToast('请填写 CF 账号邮箱和 API Key！', 'warning');

			const count = domainsArray.length;
			const confirmed = await this.customConfirm(`⚠️ 危险操作：\n\n即将调用 Cloudflare API 强制删除这 ${count} 个域名的路由解析记录。确定要继续吗？`);
			if (!confirmed) return;
			if (count > 1) this.isDeletingCfRoutes = true;
			this.showToast(`🗑️ 正在连线 Cloudflare 销毁 ${count} 条记录...`, 'info');

			try {
				const res = await this.authFetch('/api/config/delete_cf_domains', {
					method: 'POST',
					body: JSON.stringify({
						sub_domains: domainsArray.join(','),
						api_email: this.config.cf_api_email,
						api_key: this.config.cf_api_key
					})
				});
				const data = await res.json();
				if (data.status === 'success') {
					this.showToast(data.message, 'success');
					this.fetchCfRoutes();
				} else {
					this.showToast(data.message, 'error');
				}
			} catch (e) {
				this.showToast('删除接口请求失败', 'error');
			} finally {
				this.isDeletingCfRoutes = false;
			}
		},

		toggleAllCfRoutes(event) {
			if (event.target.checked) this.selectedCfRoutes = [...this.cfRoutes];
			else this.selectedCfRoutes = [];
		}
    }
}).mount('#app');