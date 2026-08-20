using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Drawing;
using System.Drawing.Printing;
using System.IO;
using System.Linq;
using System.Printing;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Forms;
using System.Windows.Markup;

namespace MatchaAccounting
{
    public partial class POSView : System.Windows.Controls.UserControl
    {
        private ObservableCollection<InventoryItem> products;
        private ObservableCollection<OrderItem> orderItems;
        private decimal total;
        private POSService posService = new POSService(); // 创建后台服务实例
        private List<Sale> salesData; // 销售数据

        public POSView()
        {
            InitializeComponent();

            // Load products from inventory
            products = LoadInventoryFromJson();
            icProducts.ItemsSource = products;

            orderItems = new ObservableCollection<OrderItem>();
            lbOrderItems.ItemsSource = orderItems;

            UpdateTotal();

            // 加载销售数据
            salesData = posService.LoadSalesData();
        }

        private void btnProduct_Click(object sender, RoutedEventArgs e)
        {
            if (sender is System.Windows.Controls.Button button && button.DataContext is InventoryItem selectedProduct)
            {
                // Add the selected product to the order
                OrderItem existingItem = orderItems.FirstOrDefault(item => item.Name == selectedProduct.Name);
                if (existingItem != null)
                {
                    existingItem.Quantity++;
                    existingItem.TotalPrice = existingItem.Quantity * selectedProduct.Price;
                }
                else
                {
                    orderItems.Add(new OrderItem
                    {
                        Name = selectedProduct.Name,
                        Quantity = 1,
                        Price = selectedProduct.Price,
                        TotalPrice = selectedProduct.Price
                    });
                }

                UpdateTotal();
            }
        }

        private void btnBindIC_Click(object sender, RoutedEventArgs e)
        {
            // Implement IC binding logic here
            string ic = txtIC.Text;
            System.Windows.Forms.MessageBox.Show($"IC bound: {ic}");
        }

        private void btnPaymentReceived_Click(object sender, RoutedEventArgs e)
        {
            // Implement payment received logic here
            string paymentMethod = (cbPaymentMethod.SelectedItem as ComboBoxItem)?.Content.ToString();
            if (string.IsNullOrEmpty(paymentMethod))
            {
                System.Windows.Forms.MessageBox.Show("Please select a payment method.");
                return;
            }

            // 生成收据
            string receiptContent = posService.GenerateReceipt(orderItems.ToList(), paymentMethod, total);

            // 保存收据到文件
            string receiptPath = posService.SaveReceiptToFile(receiptContent);

            // 保存销售数据
            Sale newSale = new Sale
            {
                Id = salesData.Count + 1,
                Date = DateTime.Now,
                Total = total
            };
            salesData.Add(newSale);
            posService.SaveSalesData(salesData);

            // 生成销售报表
            string reportContent = posService.GenerateSalesReport(salesData);
            string reportPath = posService.SaveSalesReportToFile(reportContent);

            // 打印收据
            PrintReceipt(receiptContent);

            // Clear order
            orderItems.Clear();
            UpdateTotal();

            System.Windows.Forms.MessageBox.Show("Payment received and receipt generated!");
        }

        private void PrintReceipt(string receiptContent)
        {
            // 创建 PrintDocument
            PrintDocument pd = new PrintDocument();

            pd.PrintPage += (sender, ev) =>
            {
                // 创建字体和画刷
                Font printFont = new Font("Arial", 10);
                SolidBrush brush = new SolidBrush(Color.Black);

                // 获取打印区域
                float leftMargin = ev.MarginBounds.Left;
                float topMargin = ev.MarginBounds.Top;

                // 将收据内容分行打印
                float lineHeight = printFont.GetHeight(ev.Graphics);
                string[] lines = receiptContent.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None);

                // 逐行打印文本
                foreach (var line in lines)
                {
                    ev.Graphics.DrawString(line, printFont, brush, leftMargin, topMargin);
                    topMargin += lineHeight; // 更新每行的顶部边距
                }
            };

            try
            {
                // 打印
                pd.Print();
            }
            catch (Exception ex)
            {
                // 处理异常，可能是打印机未连接或其他问题
                System.Windows.Forms.MessageBox.Show($"打印失败: {ex.Message}", "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void UpdateTotal()
        {
            total = 0;
            foreach (var item in orderItems)
            {
                total += item.TotalPrice;
            }
            tbTotal.Text = total.ToString("C2");
        }

        private ObservableCollection<InventoryItem> LoadInventoryFromJson()
        {
            const string InventoryFilePath = "inventory.json"; // Assuming inventory.json is in the same directory
            if (File.Exists(InventoryFilePath))
            {
                string json = File.ReadAllText(InventoryFilePath);
                return JsonConvert.DeserializeObject<ObservableCollection<InventoryItem>>(json) ?? new ObservableCollection<InventoryItem>();
            }
            else
            {
                return new ObservableCollection<InventoryItem>();
            }
        }

        // Add Member Button Click Event
        private void btnAddMember_Click(object sender, RoutedEventArgs e)
        {
            // Open Add Member Window
            AddMemberView addMemberView = new AddMemberView();
            addMemberView.ShowDialog();
        }

        // Settings Button Click Event
        private void btnSettings_Click(object sender, RoutedEventArgs e)
        {
            // Open Settings Window
            SettingsView settingsView = new SettingsView();
            settingsView.ShowDialog();
        }
    }
}