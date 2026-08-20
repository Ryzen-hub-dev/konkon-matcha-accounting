using System;
using System.Windows;

namespace MatchaAccounting
{
    public partial class SettingsView : Window
    {
        public SettingsView()
        {
            InitializeComponent();
        }

        private void btnSave_Click(object sender, RoutedEventArgs e)
        {
            // Implement Save Settings Logic here
            string companyName = txtCompanyName.Text;
            string logoPath = txtLogoPath.Text;
            string signaturePath = txtSignaturePath.Text;

            MessageBox.Show($"Saving settings: Company = {companyName}, Logo = {logoPath}, Signature = {signaturePath}");

            // Close the window
            this.Close();
        }
    }
}