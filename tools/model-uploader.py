import os
import sys
import json
import shutil
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from pathlib import Path


PROJECT_ROOT = Path(__file__).parent.parent.resolve()
MODELS_DIR = PROJECT_ROOT / 'Models'
SRC_DIR = PROJECT_ROOT / 'src'
TRANSLATIONS_FILE = SRC_DIR / 'model-translations.json'
INDEX_SCRIPT = PROJECT_ROOT / 'scripts' / 'generate-models-index.js'


class ModelUploader:
    def __init__(self, root):
        self.root = root
        self.root.title('War3 模型上传工具')
        self.root.geometry('720x560')
        self.root.configure(bg='#1a1a2e')
        
        self._build_ui()
        self._refresh_models_list()

    def _build_ui(self):
        title_label = tk.Label(
            self.root,
            text='War3 自定义模型上传',
            font=('Microsoft YaHei', 16, 'bold'),
            fg='#e94560',
            bg='#1a1a2e'
        )
        title_label.pack(pady=10)

        desc_label = tk.Label(
            self.root,
            text='选择一个包含 .mdx 模型的文件夹，将自动复制到项目并更新索引',
            font=('Microsoft YaHei', 9),
            fg='#aaa',
            bg='#1a1a2e'
        )
        desc_label.pack()

        folder_frame = tk.Frame(self.root, bg='#16213e')
        folder_frame.pack(fill='x', padx=20, pady=10)

        self.folder_path_var = tk.StringVar()
        folder_entry = tk.Entry(
            folder_frame,
            textvariable=self.folder_path_var,
            font=('Microsoft YaHei', 10),
            bg='#0f3460',
            fg='white',
            insertbackground='white',
            relief='flat',
            borderwidth=0
        )
        folder_entry.pack(side='left', fill='x', expand=True, padx=8, pady=8)

        browse_btn = tk.Button(
            folder_frame,
            text='浏览...',
            command=self._browse_folder,
            font=('Microsoft YaHei', 9),
            bg='#e94560',
            fg='white',
            activebackground='#c73650',
            activeforeground='white',
            relief='flat',
            cursor='hand2',
            padx=15
        )
        browse_btn.pack(side='right', padx=8, pady=8)

        action_frame = tk.Frame(self.root, bg='#1a1a2e')
        action_frame.pack(fill='x', padx=20)

        upload_btn = tk.Button(
            action_frame,
            text='📤 上传模型',
            command=self._upload_model,
            font=('Microsoft YaHei', 11, 'bold'),
            bg='#0f3460',
            fg='white',
            activebackground='#16213e',
            activeforeground='white',
            relief='flat',
            cursor='hand2',
            padx=20,
            pady=8
        )
        upload_btn.pack(side='left', padx=5)

        scan_btn = tk.Button(
            action_frame,
            text='🔄 重建索引',
            command=self._rebuild_index,
            font=('Microsoft YaHei', 11),
            bg='#533483',
            fg='white',
            activebackground='#3f2863',
            activeforeground='white',
            relief='flat',
            cursor='hand2',
            padx=15,
            pady=8
        )
        scan_btn.pack(side='left', padx=5)

        list_label = tk.Label(
            self.root,
            text='当前自定义模型列表：',
            font=('Microsoft YaHei', 10, 'bold'),
            fg='#fff',
            bg='#1a1a2e',
            anchor='w'
        )
        list_label.pack(fill='x', padx=20, pady=(15, 5))

        list_frame = tk.Frame(self.root, bg='#16213e')
        list_frame.pack(fill='both', expand=True, padx=20)

        self.tree = ttk.Treeview(
            list_frame,
            columns=('folder', 'models', 'status'),
            show='headings',
            style='Custom.Treeview'
        )
        self.tree.heading('folder', text='模型文件夹')
        self.tree.heading('models', text='MDX 文件数')
        self.tree.heading('status', text='状态')
        self.tree.column('folder', width=280, minwidth=200)
        self.tree.column('models', width=100, minwidth=60)
        self.tree.column('status', width=150, minwidth=100)

        self.tree.pack(side='left', fill='both', expand=True, padx=2, pady=2)

        scrollbar = ttk.Scrollbar(list_frame, orient='vertical', command=self.tree.yview)
        scrollbar.pack(side='right', fill='y')
        self.tree.configure(yscrollcommand=scrollbar.set)

        self.tree.bind('<Delete>', self._on_delete_key)

        style = ttk.Style()
        style.theme_use('default')
        style.configure(
            'Custom.Treeview',
            background='#0f3460',
            foreground='white',
            fieldbackground='#0f3460',
            font=('Microsoft YaHei', 9),
            borderwidth=0
        )
        style.configure(
            'Custom.Treeview.Heading',
            background='#16213e',
            foreground='#e94560',
            font=('Microsoft YaHei', 9, 'bold'),
            borderwidth=0
        )
        style.map('Custom.Treeview', background=[('selected', '#e94560')])

        delete_frame = tk.Frame(self.root, bg='#1a1a2e')
        delete_frame.pack(fill='x', padx=20, pady=10)

        delete_btn = tk.Button(
            delete_frame,
            text='🗑 删除选中',
            command=self._delete_selected,
            font=('Microsoft YaHei', 10),
            bg='#8b0000',
            fg='white',
            activebackground='#6b0000',
            activeforeground='white',
            relief='flat',
            cursor='hand2',
            padx=15,
            pady=5
        )
        delete_btn.pack(side='left')

        self.status_var = tk.StringVar(value='就绪')
        status_bar = tk.Label(
            self.root,
            textvariable=self.status_var,
            font=('Microsoft YaHei', 9),
            fg='#aaa',
            bg='#0f3460',
            anchor='w',
            padx=10,
            pady=3
        )
        status_bar.pack(side='bottom', fill='x')

    def _browse_folder(self):
        folder = filedialog.askdirectory(title='选择包含模型的文件夹')
        if folder:
            self.folder_path_var.set(folder)

    def _get_mdx_files(self, folder_path):
        mdx_files = []
        folder = Path(folder_path)
        for f in folder.iterdir():
            if f.is_file() and f.suffix.lower() == '.mdx':
                mdx_files.append(f)
        return mdx_files

    def _upload_model(self):
        source_path = self.folder_path_var.get().strip()
        if not source_path:
            messagebox.showwarning('提示', '请先选择一个文件夹')
            return

        source = Path(source_path)
        if not source.is_dir():
            messagebox.showerror('错误', '所选路径不是文件夹')
            return

        mdx_files = self._get_mdx_files(source)
        if not mdx_files:
            messagebox.showerror('错误', '所选文件夹中没有找到 .mdx 文件')
            return

        folder_name = source.name
        dest_path = MODELS_DIR / folder_name

        if dest_path.exists():
            if not messagebox.askyesno(
                '确认覆盖',
                f'目标文件夹 "{folder_name}" 已存在，是否覆盖？'
            ):
                return
            shutil.rmtree(dest_path)

        self.status_var.set(f'正在复制 {len(mdx_files)} 个 MDX 文件...')
        self.root.update()

        shutil.copytree(source, dest_path)

        mdx_names = [f.stem for f in mdx_files]
        self._update_translations(mdx_names)

        self.status_var.set('正在重建索引...')
        self.root.update()
        self._rebuild_index(silent=True)

        self._refresh_models_list()

        self.status_var.set(f'完成！已上传 {folder_name}（{len(mdx_files)} 个模型）')
        messagebox.showinfo(
            '上传成功',
            f'已成功上传模型文件夹：\n\n'
            f'📁 {folder_name}\n'
            f'📦 MDX 文件数：{len(mdx_files)}\n\n'
            f'模型索引和翻译表已更新。'
        )

    def _update_translations(self, model_names):
        translations = {}
        if TRANSLATIONS_FILE.exists():
            with open(TRANSLATIONS_FILE, 'r', encoding='utf-8') as f:
                translations = json.load(f)

        added = 0
        for name in model_names:
            if name not in translations:
                translations[name] = ''
                added += 1

        with open(TRANSLATIONS_FILE, 'w', encoding='utf-8') as f:
            json.dump(translations, f, ensure_ascii=False, indent=2)
            f.write('\n')

        if added > 0:
            self.status_var.set(f'已添加 {added} 个新翻译条目（中文留空）')
        else:
            self.status_var.set('所有模型已在翻译表中')

    def _rebuild_index(self, silent=False):
        self.status_var.set('正在重建模型索引...')
        self.root.update()

        try:
            import subprocess
            result = subprocess.run(
                ['node', str(INDEX_SCRIPT)],
                capture_output=True,
                text=True,
                cwd=str(PROJECT_ROOT),
                timeout=30
            )
            if result.returncode == 0:
                if not silent:
                    messagebox.showinfo('完成', '模型索引已重建')
                self.status_var.set('索引重建完成')
            else:
                if not silent:
                    messagebox.showerror('错误', f'索引重建失败：\n{result.stderr}')
                self.status_var.set('索引重建失败')
        except Exception as e:
            if not silent:
                messagebox.showerror('错误', f'执行失败：{str(e)}')
            self.status_var.set('执行失败')

    def _refresh_models_list(self):
        for item in self.tree.get_children():
            self.tree.delete(item)

        if not MODELS_DIR.exists():
            return

        for folder in sorted(MODELS_DIR.iterdir()):
            if not folder.is_dir():
                continue
            mdx_files = list(folder.glob('*.mdx')) + list(folder.glob('*.MDX'))
            mdx_count = len(mdx_files)

            status = '✓ 就绪' if mdx_count > 0 else '⚠ 无模型'

            self.tree.insert('', 'end', values=(folder.name, mdx_count, status))

    def _on_delete_key(self, event):
        self._delete_selected()

    def _delete_selected(self):
        selected = self.tree.selection()
        if not selected:
            messagebox.showwarning('提示', '请先选择要删除的模型文件夹')
            return

        item = selected[0]
        folder_name = self.tree.item(item, 'values')[0]

        if not messagebox.askyesno(
            '确认删除',
            f'确定要删除文件夹 "{folder_name}" 及其所有文件吗？\n此操作不可恢复。'
        ):
            return

        folder_path = MODELS_DIR / folder_name
        model_names = []
        if folder_path.exists():
            mdx_files = list(folder_path.glob('*.mdx')) + list(folder_path.glob('*.MDX'))
            model_names = [f.stem for f in mdx_files]
            shutil.rmtree(folder_path)

        self._remove_translations_for_models(model_names)

        self._rebuild_index(silent=True)
        self._refresh_models_list()
        self.status_var.set(f'已删除：{folder_name}')

    def _remove_translations_for_models(self, model_names):
        if not model_names:
            return

        if TRANSLATIONS_FILE.exists():
            with open(TRANSLATIONS_FILE, 'r', encoding='utf-8') as f:
                translations = json.load(f)

            removed = 0
            for name in model_names:
                if name in translations:
                    del translations[name]
                    removed += 1

            with open(TRANSLATIONS_FILE, 'w', encoding='utf-8') as f:
                json.dump(translations, f, ensure_ascii=False, indent=2)
                f.write('\n')

            if removed > 0:
                self.status_var.set(f'已从翻译表移除 {removed} 个条目')


def main():
    root = tk.Tk()
    app = ModelUploader(root)
    root.mainloop()


if __name__ == '__main__':
    main()
