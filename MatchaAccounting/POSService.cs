using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Text;

namespace MatchaAccounting
{
    public class POSService
    {
        private const string SalesDataFilePath = "sales_data.json";
        private const string SettingsFilePath = "settings.json";
        private const string ReceiptDirectory = "Receipts";
        private const string ReportsDirectory = "Reports";

        public POSService()
        {
            // Ensure directories exist
            Directory.CreateDirectory(ReceiptDirectory);
            Directory.CreateDirectory(ReportsDirectory);
        }

        // 加载销售数据
        public List<Sale> LoadSalesData()
        {
            if (File.Exists(SalesDataFilePath))
            {
                string json = File.ReadAllText(SalesDataFilePath);
                return JsonConvert.DeserializeObject<List<Sale>>(json) ?? new List<Sale>();
            }
            else
            {
                return new List<Sale>();
            }
        }

        // 保存销售数据
        public void SaveSalesData(List<Sale> sales)
        {
            string json = JsonConvert.SerializeObject(sales, Formatting.Indented);
            File.WriteAllText(SalesDataFilePath, json);
        }

        // 生成收据
        public string GenerateReceipt(List<OrderItem> orderItems, string paymentMethod, decimal total)
        {
            Settings settings = LoadSettings();

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("============================");
            sb.AppendLine($"      {settings.CompanyName}     ");
            sb.AppendLine("============================");
            sb.AppendLine($"Date: {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
            sb.AppendLine($"Payment Method: {paymentMethod}");
            sb.AppendLine("----------------------------");
            foreach (var item in orderItems)
            {
                sb.AppendLine($"{item.Name} x{item.Quantity} {item.TotalPrice:C2}");
            }
            sb.AppendLine("----------------------------");
            sb.AppendLine($"Total: {total:C2}");
            sb.AppendLine("============================");
            sb.AppendLine("Thank you for your purchase!");

            return sb.ToString();
        }

        // 保存收据到文件
        public string SaveReceiptToFile(string receiptContent)
        {
            string receiptFileName = $"Receipt_{DateTime.Now:yyyyMMdd_HHmmss}.txt";
            string receiptPath = Path.Combine(ReceiptDirectory, receiptFileName);
            File.WriteAllText(receiptPath, receiptContent);
            return receiptPath;
        }

        // 生成销售报表
        public string GenerateSalesReport(List<Sale> sales)
        {
            Settings settings = LoadSettings();

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("============================");
            sb.AppendLine($"      {settings.CompanyName} Sales Report     ");
            sb.AppendLine("============================");
            sb.AppendLine($"Date: {DateTime.Now:yyyy-MM-dd}");
            sb.AppendLine("----------------------------");

            decimal totalSales = 0;
            foreach (var sale in sales)
            {
                sb.AppendLine($"Sale ID: {sale.Id}, Date: {sale.Date:yyyy-MM-dd HH:mm:ss}, Total: {sale.Total:C2}");
                totalSales += sale.Total;
            }

            sb.AppendLine("----------------------------");
            sb.AppendLine($"Total Sales: {totalSales:C2}");
            sb.AppendLine("============================");

            return sb.ToString();
        }

        // 保存销售报表到文件
        public string SaveSalesReportToFile(string reportContent)
        {
            string reportFileName = $"SalesReport_{DateTime.Now:yyyyMMdd_HHmmss}.txt";
            string reportPath = Path.Combine(ReportsDirectory, reportFileName);
            File.WriteAllText(reportPath, reportContent);
            return reportPath;
        }

        // 加载设置
        public Settings LoadSettings()
        {
            if (File.Exists(SettingsFilePath))
            {
                string json = File.ReadAllText(SettingsFilePath);
                return JsonConvert.DeserializeObject<Settings>(json) ?? new Settings();
            }
            else
            {
                return new Settings();
            }
        }

        // 保存设置
        public void SaveSettings(Settings settings)
        {
            string json = JsonConvert.SerializeObject(settings, Formatting.Indented);
            File.WriteAllText(SettingsFilePath, json);
        }
    }
}