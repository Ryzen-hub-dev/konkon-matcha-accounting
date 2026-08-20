using System;
using System.Windows;

namespace MatchaAccounting
{
    public partial class AddMemberView : Window
    {
        public AddMemberView()
        {
            InitializeComponent();
        }

        private void btnAdd_Click(object sender, RoutedEventArgs e)
        {
            // Implement Add Member Logic here
            string icNumber = txtICNumber.Text;
            string name = txtName.Text;

            MessageBox.Show($"Adding member: IC = {icNumber}, Name = {name}");

            // Close the window
            this.Close();
        }
    }
}